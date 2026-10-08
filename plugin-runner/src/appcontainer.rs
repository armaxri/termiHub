//! Windows: one plugin's Less-Privileged AppContainer, host side (#4187).
//!
//! Every plugin gets its own AppContainer profile, named deterministically
//! from its id ([`app_container_name`]), created on first use and reused
//! afterwards ([`AppContainer::ensure`]), and removed on uninstall
//! ([`delete_profile`]). The runner is started inside it as a
//! **less-privileged** AppContainer (LPAC) with **zero capabilities**
//! ([`crate::process::RunnerCommand::app_container`]), which the phase-0 spike
//! (#4181) chose: no network, no user profile, no `HKCU\Software`, no child
//! processes, and no access to anything that grants only "ALL APPLICATION
//! PACKAGES".
//!
//! Such a process reaches only what grants its SID explicitly, so the host adds
//! allow entries for it ([`AppContainer::grant_tree`],
//! [`AppContainer::grant_object`]): read + execute on the runner itself and on
//! the plugin's install folder, modify on its data folder. Grants are
//! idempotent: an entry that is already there is not written again, so a
//! respawn does not touch the ACLs. On uninstall the profile is deleted
//! together with the grants the host made outside the plugin's own folders
//! ([`delete_profile_revoking`]), so the runner's ACL is left as it was.
//!
//! [`app_container_name`]: crate::sandbox::app_container_name

use std::ffi::c_void;
use std::io;
use std::path::Path;
use std::sync::Mutex;

use windows_sys::Win32::Foundation::{LocalFree, ERROR_ALREADY_EXISTS, HLOCAL, TRUE};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW,
    EXPLICIT_ACCESS_W, GRANT_ACCESS, NO_MULTIPLE_TRUSTEE, SE_FILE_OBJECT, TRUSTEE_IS_SID,
    TRUSTEE_IS_WELL_KNOWN_GROUP, TRUSTEE_W,
};
use windows_sys::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeleteAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
};
use windows_sys::Win32::Security::{
    CopySid, DeleteAce, EqualSid, FreeSid, GetAce, GetFileSecurityW, GetLengthSid,
    GetSecurityDescriptorControl, GetSecurityDescriptorDacl, InitializeSecurityDescriptor,
    SetFileSecurityW, SetSecurityDescriptorControl, SetSecurityDescriptorDacl, ACCESS_ALLOWED_ACE,
    ACE_FLAGS, ACL, DACL_SECURITY_INFORMATION, INHERITED_ACE, NO_INHERITANCE,
    PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SECURITY_DESCRIPTOR,
    SE_DACL_AUTO_INHERITED, SE_DACL_PROTECTED, SUB_CONTAINERS_AND_OBJECTS_INHERIT,
};
use windows_sys::Win32::Storage::FileSystem::{
    DELETE, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
};

use crate::sandbox::app_container_name;
use crate::win::{os_error, to_wide};

/// Read and execute: list a folder, read and map files.
pub const READ_EXECUTE: u32 = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;
/// Modify: read, execute, write, create, delete.
pub const MODIFY: u32 = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE | FILE_GENERIC_WRITE | DELETE;

/// `ACCESS_ALLOWED_ACE_TYPE` (`winnt.h`).
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
/// `SECURITY_DESCRIPTOR_REVISION` (`winnt.h`).
const SECURITY_DESCRIPTOR_REVISION: u32 = 1;

/// Serialises this process's read-modify-write of ACLs, so two plugins
/// granting the shared runner folder at once cannot lose each other's entry.
static ACL_LOCK: Mutex<()> = Mutex::new(());

/// Serialises this process's profile creation and deletion. Two concurrent
/// `CreateAppContainerProfile` calls for one name race inside the API: one
/// fails (`ERROR_BAD_ENVIRONMENT`) and rolls its half-made profile back while
/// the other already uses it, and a runner spawned meanwhile fails with
/// `ERROR_FILE_NOT_FOUND`. A plugin can be (re)started from several threads at
/// once, so every profile operation takes this lock.
static PROFILE_LOCK: Mutex<()> = Mutex::new(());

/// One plugin's AppContainer: its profile name and SID.
#[derive(Clone, PartialEq, Eq)]
pub struct AppContainer {
    name: String,
    sid: Box<[u32]>,
    sid_string: String,
}

impl std::fmt::Debug for AppContainer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppContainer")
            .field("name", &self.name)
            .field("sid", &self.sid_string)
            .finish()
    }
}

impl AppContainer {
    /// Create plugin `plugin_id`'s profile with zero capabilities, or reuse it
    /// when it already exists.
    pub fn ensure(plugin_id: &str) -> io::Result<Self> {
        let name = app_container_name(plugin_id);
        let wide_name = to_wide(name.as_ref())?;
        let display = to_wide(format!("termiHub plugin {plugin_id}").as_ref())?;
        let description = to_wide("Sandbox of one termiHub native plugin".as_ref())?;
        let mut sid: PSID = std::ptr::null_mut();
        let _guard = PROFILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // SAFETY: NUL-terminated strings; no capabilities; `sid` receives a
        // SID freed with `FreeSid` below.
        let hr = unsafe {
            CreateAppContainerProfile(
                wide_name.as_ptr(),
                display.as_ptr(),
                description.as_ptr(),
                std::ptr::null(),
                0,
                &mut sid,
            )
        };
        // Another process (a second termiHub instance) may have created it
        // concurrently: a failed create whose profile now exists is reused.
        let created_elsewhere = || hr < 0 && profile_exists_unlocked(plugin_id).unwrap_or(false);
        if hr == hresult_from_win32(ERROR_ALREADY_EXISTS) || created_elsewhere() {
            // SAFETY: NUL-terminated name; `sid` receives a SID freed below.
            let hr =
                unsafe { DeriveAppContainerSidFromAppContainerName(wide_name.as_ptr(), &mut sid) };
            check_hresult(hr, "DeriveAppContainerSidFromAppContainerName")?;
        } else {
            check_hresult(hr, "CreateAppContainerProfile")?;
        }
        let owned = FreedSid(sid);
        let sid = copy_sid(owned.0)?;
        let sid_string = sid_to_string(sid.as_ptr().cast_mut().cast())?;
        Ok(Self {
            name,
            sid,
            sid_string,
        })
    }

    /// The profile name (`termiHub.Plugin.<hash>`).
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The AppContainer SID in string form (`S-1-15-2-…`), e.g. for a pipe
    /// DACL ([`crate::ipc::pipe::PipeStream::pair_with_access`]).
    #[must_use]
    pub fn sid_string(&self) -> &str {
        &self.sid_string
    }

    /// The SID, valid while `self` lives.
    pub(crate) fn sid(&self) -> PSID {
        self.sid.as_ptr().cast_mut().cast()
    }

    /// Grant the AppContainer `access` on the folder `path` and everything in
    /// it, now and later (an inheritable entry, propagated to what exists).
    pub fn grant_tree(&self, path: &Path, access: u32) -> io::Result<()> {
        self.grant(path, access, SUB_CONTAINERS_AND_OBJECTS_INHERIT)
    }

    /// Grant the AppContainer `access` on the file or folder `path` itself
    /// only (no inheritance, nothing propagated to a folder's contents).
    pub fn grant_object(&self, path: &Path, access: u32) -> io::Result<()> {
        self.grant(path, access, NO_INHERITANCE)
    }

    fn grant(&self, path: &Path, access: u32, inheritance: ACE_FLAGS) -> io::Result<()> {
        let wide = to_wide(path.as_os_str())?;
        let _guard = ACL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // An object-only grant is a plain rewrite of the DACL as stored; a
        // tree grant goes through `SetNamedSecurityInfoW`, which recomputes
        // the inherited part anyway, so it starts from the same API's view.
        let current = if inheritance == NO_INHERITANCE {
            Dacl::stored(&wide)?
        } else {
            Dacl::of(&wide)?
        };
        if current.allows(self.sid(), access, inheritance) {
            return Ok(());
        }
        let updated = current.with_grant(self.sid(), access, inheritance)?;
        if inheritance == NO_INHERITANCE {
            // A plain write of this object's DACL: `SetNamedSecurityInfoW`
            // would walk a folder's whole tree to re-propagate inheritance,
            // which the runner's folder (a cargo target dir in tests) makes
            // slow, and a non-inheritable entry does not need.
            write_dacl_only(&wide, updated.acl, current.inheritance_control())
        } else {
            // SAFETY: NUL-terminated path; `updated.acl` is a valid ACL.
            let status = unsafe {
                SetNamedSecurityInfoW(
                    wide.as_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    updated.acl,
                    std::ptr::null(),
                )
            };
            win32_result(status)
        }
    }
}

/// Delete plugin `plugin_id`'s AppContainer profile (on uninstall). A profile
/// that does not exist is not an error.
pub fn delete_profile(plugin_id: &str) -> io::Result<()> {
    delete_profile_revoking(plugin_id, &[]).map(|_| ())
}

/// A grant [`delete_profile_revoking`] could not take back, and why.
pub type RevokeFailure = (std::path::PathBuf, io::Error);

/// Delete plugin `plugin_id`'s AppContainer profile (on uninstall), first
/// revoking its SID's explicit allow entries from each of `objects` (the
/// runner executable and its folder, granted with
/// [`AppContainer::grant_object`]). Only that SID's own, non-inherited entries
/// go; every other entry, inherited ones such as "ALL RESTRICTED APPLICATION
/// PACKAGES" included, stays as it is, and an object without such an entry is
/// not written at all.
///
/// Both happen under the profile lock, so a concurrent
/// [`AppContainer::ensure`] of the same plugin runs entirely before or after.
/// A revoke that fails (typically refused, like the grant on a per-machine
/// install, or a path that no longer exists) does not stop the deletion: it is
/// returned for the caller to report. A profile that does not exist is not an
/// error.
pub fn delete_profile_revoking(
    plugin_id: &str,
    objects: &[&Path],
) -> io::Result<Vec<RevokeFailure>> {
    let wide = to_wide(app_container_name(plugin_id).as_ref())?;
    let _guard = PROFILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut failures = Vec::new();
    if !objects.is_empty() {
        let mut sid: PSID = std::ptr::null_mut();
        // SAFETY: NUL-terminated name; `sid` receives a SID freed below. The
        // SID is derived from the name alone, so it exists with or without
        // the profile.
        let hr = unsafe { DeriveAppContainerSidFromAppContainerName(wide.as_ptr(), &mut sid) };
        check_hresult(hr, "DeriveAppContainerSidFromAppContainerName")?;
        let sid = FreedSid(sid);
        for &object in objects {
            if let Err(e) = revoke(sid.0, object) {
                failures.push((object.to_owned(), e));
            }
        }
    }
    // SAFETY: NUL-terminated name.
    let hr = unsafe { DeleteAppContainerProfile(wide.as_ptr()) };
    // ERROR_FILE_NOT_FOUND / ERROR_PATH_NOT_FOUND / ERROR_NOT_FOUND: nothing
    // to delete.
    if [2, 3, 1168]
        .into_iter()
        .any(|code| hr == hresult_from_win32(code))
    {
        return Ok(failures);
    }
    check_hresult(hr, "DeleteAppContainerProfile")?;
    Ok(failures)
}

/// Remove `sid`'s explicit allow entries from the DACL of `path` itself
/// (nothing is re-propagated to a folder's contents: the entries the host
/// grants there are not inheritable).
fn revoke(sid: PSID, path: &Path) -> io::Result<()> {
    let wide = to_wide(path.as_os_str())?;
    let _guard = ACL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let current = Dacl::stored(&wide)?;
    match current.without(sid)? {
        Some(mut updated) => {
            write_dacl_only(&wide, updated.as_mut_ptr(), current.inheritance_control())
        }
        None => Ok(()),
    }
}

/// Where Windows records each AppContainer profile, one subkey per SID.
const PROFILE_MAPPINGS_KEY: &str = r"Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppContainer\Mappings";

/// Whether plugin `plugin_id`'s AppContainer profile exists (its mapping is
/// registered for the current user).
pub fn profile_exists(plugin_id: &str) -> io::Result<bool> {
    let _guard = PROFILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    profile_exists_unlocked(plugin_id)
}

/// [`profile_exists`] for a caller that holds `PROFILE_LOCK`.
fn profile_exists_unlocked(plugin_id: &str) -> io::Result<bool> {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_READ,
    };
    let name = to_wide(app_container_name(plugin_id).as_ref())?;
    let mut sid: PSID = std::ptr::null_mut();
    // SAFETY: NUL-terminated name; `sid` receives a SID freed below.
    let hr = unsafe { DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut sid) };
    check_hresult(hr, "DeriveAppContainerSidFromAppContainerName")?;
    let sid = FreedSid(sid);
    let key_path = format!(r"{PROFILE_MAPPINGS_KEY}\{}", sid_to_string(sid.0)?);
    let wide = to_wide(key_path.as_ref())?;
    let mut key: HKEY = std::ptr::null_mut();
    // SAFETY: a predefined root, a NUL-terminated subkey, an out-pointer for
    // a key closed below.
    let status = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, wide.as_ptr(), 0, KEY_READ, &mut key) };
    if status != 0 {
        return Ok(false);
    }
    // SAFETY: the key opened above, closed once.
    unsafe { RegCloseKey(key) };
    Ok(true)
}

/// `HRESULT_FROM_WIN32`.
fn hresult_from_win32(code: u32) -> i32 {
    if code == 0 {
        0
    } else {
        // Reinterpret the 0x8007xxxx bit pattern as the signed HRESULT.
        ((code & 0xFFFF) | 0x8007_0000) as i32
    }
}

fn check_hresult(hr: i32, call: &str) -> io::Result<()> {
    if hr >= 0 {
        return Ok(());
    }
    // A Win32 error wrapped in an HRESULT keeps its code; others stay hex.
    let unsigned = hr as u32;
    if unsigned & 0xFFFF_0000 == 0x8007_0000 {
        let error = os_error(unsigned & 0xFFFF);
        return Err(io::Error::new(
            error.kind(),
            format!("{call} failed: {error}"),
        ));
    }
    Err(io::Error::other(format!("{call} failed: {unsigned:#010x}")))
}

fn win32_result(status: u32) -> io::Result<()> {
    if status == 0 {
        Ok(())
    } else {
        Err(os_error(status))
    }
}

/// A SID allocated by the AppContainer API, freed with `FreeSid`.
struct FreedSid(PSID);

impl Drop for FreedSid {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: allocated by `CreateAppContainerProfile` /
            // `DeriveAppContainerSidFromAppContainerName`, freed once.
            unsafe { FreeSid(self.0) };
        }
    }
}

/// An owned copy of `sid`, in `u32` storage (aligned like a SID's
/// sub-authorities).
fn copy_sid(sid: PSID) -> io::Result<Box<[u32]>> {
    // SAFETY: `sid` is a valid SID.
    let len = unsafe { GetLengthSid(sid) };
    let mut buffer = vec![0u32; (len as usize).div_ceil(4)].into_boxed_slice();
    // SAFETY: `buffer` holds at least `len` writable bytes.
    if unsafe { CopySid(len, buffer.as_mut_ptr().cast(), sid) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(buffer)
}

/// `sid` as `S-1-…`.
fn sid_to_string(sid: PSID) -> io::Result<String> {
    let mut wide: *mut u16 = std::ptr::null_mut();
    // SAFETY: `sid` is valid; `wide` receives a `LocalAlloc`ed string.
    if unsafe { ConvertSidToStringSidW(sid, &mut wide) } != TRUE {
        return Err(io::Error::last_os_error());
    }
    let mut chars = 0usize;
    // SAFETY: `wide` is NUL-terminated.
    let text = unsafe {
        while *wide.add(chars) != 0 {
            chars += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(wide, chars))
    };
    // SAFETY: allocated by `ConvertSidToStringSidW`.
    unsafe { LocalFree(wide as HLOCAL) };
    Ok(text)
}

/// An object's DACL, read with `GetNamedSecurityInfoW` (the descriptor that
/// owns it is freed on drop).
struct Dacl {
    descriptor: PSECURITY_DESCRIPTOR,
    acl: *mut ACL,
    /// The buffer `descriptor` lives in, for [`Dacl::stored`]; `None` when
    /// `GetNamedSecurityInfoW` allocated it (freed on drop).
    stored: Option<Box<[u64]>>,
}

impl Dacl {
    /// The DACL as `GetNamedSecurityInfoW` reports it. For an object whose
    /// DACL is not auto-inherited (entries copied from its parent without the
    /// inherited flag, as Windows creates files under such a folder), the
    /// API converts it: the entries the parent would pass on come back marked
    /// inherited, the descriptor auto-inherited. Fine for
    /// `SetNamedSecurityInfoW`, which recomputes inheritance anyway, but
    /// written back as is it changes the object (#4263): use [`Dacl::stored`]
    /// for a plain rewrite.
    fn of(path: &[u16]) -> io::Result<Self> {
        let mut acl: *mut ACL = std::ptr::null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        // SAFETY: NUL-terminated path; the out-pointers receive a
        // `LocalAlloc`ed descriptor (freed on drop) and a DACL inside it.
        let status = unsafe {
            GetNamedSecurityInfoW(
                path.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut acl,
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        win32_result(status)?;
        Ok(Self {
            descriptor,
            acl,
            stored: None,
        })
    }

    /// The DACL exactly as stored on the object (`GetFileSecurityW`, no
    /// conversion), for a plain rewrite with [`write_dacl_only`] that changes
    /// nothing but the entries the caller adds or removes.
    fn stored(path: &[u16]) -> io::Result<Self> {
        let mut needed = 0u32;
        // SAFETY: NUL-terminated path; a size query (no buffer).
        unsafe {
            GetFileSecurityW(
                path.as_ptr(),
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                0,
                &mut needed,
            )
        };
        if needed == 0 {
            return Err(io::Error::last_os_error());
        }
        // `u64` storage: a self-relative descriptor's fields need alignment.
        let mut buffer = vec![0u64; (needed as usize).div_ceil(8)].into_boxed_slice();
        let descriptor: PSECURITY_DESCRIPTOR = buffer.as_mut_ptr().cast();
        // SAFETY: `buffer` holds at least `needed` writable bytes.
        if unsafe {
            GetFileSecurityW(
                path.as_ptr(),
                DACL_SECURITY_INFORMATION,
                descriptor,
                needed,
                &mut needed,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let (mut present, mut defaulted) = (0, 0);
        let mut acl: *mut ACL = std::ptr::null_mut();
        // SAFETY: a valid self-relative descriptor in `buffer`; writable
        // out-pointers. `acl` points into `buffer`, which `Self` keeps (a
        // boxed slice does not move with its owner).
        if unsafe { GetSecurityDescriptorDacl(descriptor, &mut present, &mut acl, &mut defaulted) }
            == 0
        {
            return Err(io::Error::last_os_error());
        }
        if present == 0 {
            // No DACL at all grants everyone everything, like a NULL one.
            acl = std::ptr::null_mut();
        }
        Ok(Self {
            descriptor,
            acl,
            stored: Some(buffer),
        })
    }

    /// The descriptor's DACL inheritance bits (auto-inherited, protected),
    /// to carry over when the DACL is rewritten in place.
    fn inheritance_control(&self) -> u16 {
        let mut control = 0u16;
        let mut revision = 0u32;
        // SAFETY: a valid descriptor; both out-pointers are writable.
        if unsafe { GetSecurityDescriptorControl(self.descriptor, &mut control, &mut revision) }
            == 0
        {
            return 0;
        }
        control & (SE_DACL_AUTO_INHERITED | SE_DACL_PROTECTED)
    }

    /// Whether an explicit allow entry for `sid` grants at least `access`
    /// with `inheritance`.
    fn allows(&self, sid: PSID, access: u32, inheritance: ACE_FLAGS) -> bool {
        if self.acl.is_null() {
            // A NULL DACL grants everyone everything.
            return true;
        }
        self.explicit_allows_for(sid).any(|(_, flags, mask)| {
            u32::from(flags) & inheritance == inheritance && mask & access == access
        })
    }

    /// The explicit (not inherited) allow entries for `sid`: index, flags and
    /// access mask of each.
    fn explicit_allows_for(&self, sid: PSID) -> impl Iterator<Item = (u32, u8, u32)> + '_ {
        let count = if self.acl.is_null() {
            0
        } else {
            // SAFETY: a valid ACL inside the descriptor we hold.
            unsafe { (*self.acl).AceCount }
        };
        (0..u32::from(count)).filter_map(move |index| {
            let mut ace: *mut c_void = std::ptr::null_mut();
            // SAFETY: `index` is below the ACE count.
            if unsafe { GetAce(self.acl, index, &mut ace) } == 0 {
                return None;
            }
            let ace = ace.cast::<ACCESS_ALLOWED_ACE>();
            // SAFETY: every ACE starts with an `ACE_HEADER`; the allowed-ACE
            // layout is only read once the type says it is one.
            let header = unsafe { (*ace).Header };
            if header.AceType != ACCESS_ALLOWED_ACE_TYPE
                || u32::from(header.AceFlags) & INHERITED_ACE != 0
            {
                return None;
            }
            // SAFETY: an allowed ACE: mask, then the SID at `SidStart`.
            let (mask, ace_sid) = unsafe {
                (
                    (*ace).Mask,
                    std::ptr::addr_of_mut!((*ace).SidStart).cast::<c_void>(),
                )
            };
            // SAFETY: both are valid SIDs.
            (unsafe { EqualSid(ace_sid, sid) } != 0).then_some((index, header.AceFlags, mask))
        })
    }

    /// A copy of this DACL without `sid`'s explicit allow entries, or `None`
    /// when it has none (or is NULL) and nothing needs writing.
    fn without(&self, sid: PSID) -> io::Result<Option<OwnedAcl>> {
        let doomed: Vec<u32> = self
            .explicit_allows_for(sid)
            .map(|(index, ..)| index)
            .collect();
        if doomed.is_empty() {
            return Ok(None);
        }
        // SAFETY: a valid, non-NULL ACL (it has entries).
        let size = usize::from(unsafe { (*self.acl).AclSize });
        let mut copy = vec![0u32; size.div_ceil(4)].into_boxed_slice();
        // SAFETY: `copy` holds at least `size` bytes, the ACL's whole extent;
        // the two do not overlap.
        unsafe {
            std::ptr::copy_nonoverlapping(self.acl.cast::<u8>(), copy.as_mut_ptr().cast(), size);
        }
        let mut acl = OwnedAcl(copy);
        // Highest index first, so the lower indices stay valid.
        for index in doomed.into_iter().rev() {
            // SAFETY: a valid ACL we own; `index` names an entry in it.
            if unsafe { DeleteAce(acl.as_mut_ptr(), index) } == 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(Some(acl))
    }

    /// A new DACL: this one plus an allow entry for `sid`.
    fn with_grant(&self, sid: PSID, access: u32, inheritance: ACE_FLAGS) -> io::Result<NewAcl> {
        let entry = EXPLICIT_ACCESS_W {
            grfAccessPermissions: access,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: inheritance,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: std::ptr::null_mut(),
                MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_WELL_KNOWN_GROUP,
                ptstrName: sid.cast(),
            },
        };
        let mut acl: *mut ACL = std::ptr::null_mut();
        // SAFETY: one entry naming a valid SID; the old DACL is valid (or
        // NULL); `acl` receives a `LocalAlloc`ed ACL freed by `NewAcl`.
        let status = unsafe { SetEntriesInAclW(1, &entry, self.acl, &mut acl) };
        win32_result(status)?;
        Ok(NewAcl { acl })
    }
}

impl Drop for Dacl {
    fn drop(&mut self) {
        if self.stored.is_none() {
            // SAFETY: allocated by `GetNamedSecurityInfoW`.
            unsafe { LocalFree(self.descriptor as HLOCAL) };
        }
    }
}

/// An ACL built by `SetEntriesInAclW`.
struct NewAcl {
    acl: *mut ACL,
}

impl Drop for NewAcl {
    fn drop(&mut self) {
        // SAFETY: allocated by `SetEntriesInAclW`.
        unsafe { LocalFree(self.acl as HLOCAL) };
    }
}

/// An ACL copied into memory we own (`u32` storage: an ACL is DWORD aligned).
struct OwnedAcl(Box<[u32]>);

impl OwnedAcl {
    fn as_mut_ptr(&mut self) -> *mut ACL {
        self.0.as_mut_ptr().cast()
    }
}

/// Replace the DACL of `path` with `acl` (keeping the inheritance `control`
/// bits), without re-propagating inheritance to a folder's contents.
fn write_dacl_only(path: &[u16], acl: *mut ACL, control: u16) -> io::Result<()> {
    // SAFETY: all-zero is a valid buffer for `InitializeSecurityDescriptor`.
    let mut descriptor: SECURITY_DESCRIPTOR = unsafe { std::mem::zeroed() };
    let raw: PSECURITY_DESCRIPTOR = std::ptr::from_mut(&mut descriptor).cast();
    // SAFETY: `raw` points at a writable absolute descriptor.
    if unsafe { InitializeSecurityDescriptor(raw, SECURITY_DESCRIPTOR_REVISION) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `acl` is valid and outlives the descriptor's use below.
    if unsafe { SetSecurityDescriptorDacl(raw, 1, acl, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let bits = SE_DACL_AUTO_INHERITED | SE_DACL_PROTECTED;
    // SAFETY: `raw` is an initialised absolute descriptor; only settable
    // control bits are passed.
    if unsafe { SetSecurityDescriptorControl(raw, bits, control & bits) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // A protected DACL is written as protected explicitly; an unprotected one
    // with no extra flag, so the system does not recompute its inherited part.
    let information = if control & SE_DACL_PROTECTED != 0 {
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION
    } else {
        DACL_SECURITY_INFORMATION
    };
    // SAFETY: NUL-terminated path; a valid absolute descriptor.
    if unsafe { SetFileSecurityW(path.as_ptr(), information, raw) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hresults_wrap_win32_codes() {
        assert_eq!(hresult_from_win32(0), 0);
        assert_eq!(hresult_from_win32(ERROR_ALREADY_EXISTS) as u32, 0x8007_00B7);
        assert!(check_hresult(0, "x").is_ok());
        let err = check_hresult(hresult_from_win32(5), "Call").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
        assert!(err.to_string().starts_with("Call failed"), "{err}");
    }

    /// Many threads ensuring one plugin's profile at once (several loads of
    /// the same plugin) all get it, with one SID; no call sees the API's
    /// internal create race (`ERROR_BAD_ENVIRONMENT`).
    #[test]
    fn concurrent_ensures_of_one_profile_all_succeed() {
        let id = format!("appcontainer-race-{}", std::process::id());
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let id = id.clone();
                std::thread::spawn(move || AppContainer::ensure(&id))
            })
            .collect();
        let containers: Vec<_> = threads
            .into_iter()
            .map(|t| t.join().unwrap().unwrap())
            .collect();
        delete_profile(&id).unwrap();
        assert!(containers.windows(2).all(|pair| pair[0] == pair[1]));
    }

    /// A profile is created once, reused with the same SID, granted on a
    /// folder idempotently, and deleted.
    #[test]
    fn a_profile_is_created_reused_granted_and_deleted() {
        let id = format!("appcontainer-unit-{}", std::process::id());
        let first = AppContainer::ensure(&id).unwrap();
        assert!(first.sid_string().starts_with("S-1-15-2-"), "{first:?}");
        let again = AppContainer::ensure(&id).unwrap();
        assert_eq!(first, again);
        assert!(profile_exists(&id).unwrap());

        let tmp = tempfile::TempDir::new().unwrap();
        let wide = to_wide(tmp.path().as_os_str()).unwrap();
        assert!(!Dacl::of(&wide).unwrap().allows(
            first.sid(),
            MODIFY,
            SUB_CONTAINERS_AND_OBJECTS_INHERIT
        ));
        first.grant_tree(tmp.path(), MODIFY).unwrap();
        first.grant_tree(tmp.path(), MODIFY).unwrap();
        let dacl = Dacl::of(&wide).unwrap();
        assert!(dacl.allows(first.sid(), MODIFY, SUB_CONTAINERS_AND_OBJECTS_INHERIT));
        let file = tmp.path().join("exe");
        std::fs::write(&file, b"x").unwrap();
        first.grant_object(&file, READ_EXECUTE).unwrap();
        let wide = to_wide(file.as_os_str()).unwrap();
        assert!(Dacl::of(&wide)
            .unwrap()
            .allows(first.sid(), READ_EXECUTE, NO_INHERITANCE));

        delete_profile(&id).unwrap();
        assert!(!profile_exists(&id).unwrap());
        delete_profile(&id).unwrap();
    }

    /// Deleting a profile revokes its SID's explicit entries from the given
    /// objects and nothing else: another plugin's entry and the inherited
    /// entries stay, an object without an entry is left alone, and a revoke
    /// that fails is reported without stopping the deletion (#4263).
    #[test]
    fn deleting_a_profile_revokes_only_its_own_grants() {
        let ours = format!("appcontainer-revoke-{}", std::process::id());
        let theirs = format!("appcontainer-keep-{}", std::process::id());
        let a = AppContainer::ensure(&ours).unwrap();
        let b = AppContainer::ensure(&theirs).unwrap();

        let tmp = tempfile::TempDir::new().unwrap();
        let file = tmp.path().join("runner.exe");
        std::fs::write(&file, b"x").unwrap();
        let wide_file = to_wide(file.as_os_str()).unwrap();
        let wide_dir = to_wide(tmp.path().as_os_str()).unwrap();
        let inherited = |wide: &[u16]| {
            let dacl = Dacl::of(wide).unwrap();
            // SAFETY: a valid ACL inside the descriptor `dacl` holds.
            let count = unsafe { (*dacl.acl).AceCount };
            (0..u32::from(count))
                .filter(|&index| {
                    let mut ace: *mut c_void = std::ptr::null_mut();
                    // SAFETY: `index` is below the ACE count.
                    unsafe { GetAce(dacl.acl, index, &mut ace) };
                    // SAFETY: every ACE starts with an `ACE_HEADER`.
                    let flags = unsafe { (*ace.cast::<ACCESS_ALLOWED_ACE>()).Header.AceFlags };
                    u32::from(flags) & INHERITED_ACE != 0
                })
                .count()
        };
        let inherited_before = inherited(&wide_file);
        assert!(
            inherited_before > 0,
            "a temp file inherits its folder's ACL"
        );

        for container in [&a, &b] {
            container.grant_object(&file, READ_EXECUTE).unwrap();
        }
        b.grant_object(tmp.path(), READ_EXECUTE).unwrap();
        let missing = tmp.path().join("no-such-runner.exe");

        let failures = delete_profile_revoking(&ours, &[&file, tmp.path(), &missing]).unwrap();
        assert!(!profile_exists(&ours).unwrap());
        assert_eq!(failures.len(), 1, "{failures:?}");
        assert_eq!(failures[0].0, missing);
        assert_eq!(failures[0].1.kind(), io::ErrorKind::NotFound);

        let file_dacl = Dacl::of(&wide_file).unwrap();
        assert!(!file_dacl.allows(a.sid(), READ_EXECUTE, NO_INHERITANCE));
        assert!(file_dacl.allows(b.sid(), READ_EXECUTE, NO_INHERITANCE));
        assert_eq!(inherited(&wide_file), inherited_before);
        assert!(Dacl::of(&wide_dir)
            .unwrap()
            .allows(b.sid(), READ_EXECUTE, NO_INHERITANCE));

        // Again: nothing left to revoke, nothing to delete.
        assert!(delete_profile_revoking(&ours, &[&file]).unwrap().is_empty());
        delete_profile(&theirs).unwrap();
    }

    /// The raw DACL of `path` as stored (`GetFileSecurityW`, no conversion):
    /// its inheritance control bits and the ACL bytes.
    fn stored_dacl(path: &Path) -> (u16, Vec<u8>) {
        let wide = to_wide(path.as_os_str()).unwrap();
        let mut needed = 0u32;
        // SAFETY: a size query: no buffer, `needed` receives the size.
        unsafe {
            GetFileSecurityW(
                wide.as_ptr(),
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                0,
                &mut needed,
            )
        };
        let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
        let descriptor: PSECURITY_DESCRIPTOR = buffer.as_mut_ptr().cast();
        // SAFETY: `buffer` holds `needed` writable bytes.
        let ok = unsafe {
            GetFileSecurityW(
                wide.as_ptr(),
                DACL_SECURITY_INFORMATION,
                descriptor,
                needed,
                &mut needed,
            )
        };
        assert_ne!(ok, 0, "{}", io::Error::last_os_error());
        let (mut control, mut revision) = (0u16, 0u32);
        let (mut present, mut defaulted) = (0, 0);
        let mut acl: *mut ACL = std::ptr::null_mut();
        // SAFETY: a valid self-relative descriptor; writable out-pointers.
        unsafe {
            GetSecurityDescriptorControl(descriptor, &mut control, &mut revision);
            GetSecurityDescriptorDacl(descriptor, &mut present, &mut acl, &mut defaulted);
        }
        assert!(present != 0 && !acl.is_null());
        // SAFETY: a valid ACL inside `buffer`, `AclSize` bytes long.
        let bytes = unsafe {
            std::slice::from_raw_parts(acl.cast::<u8>(), usize::from((*acl).AclSize)).to_vec()
        };
        (
            control & (SE_DACL_AUTO_INHERITED | SE_DACL_PROTECTED),
            bytes,
        )
    }

    /// Rewrite the DACL of `path` with every entry explicit and only the
    /// `control` inheritance bits: a pre-Windows-2000 style DACL (0), as a
    /// file or folder created under a non-auto-inherited parent has, or a
    /// protected one (`SE_DACL_PROTECTED`).
    fn make_explicit(path: &Path, control: u16) {
        let (_, bytes) = stored_dacl(path);
        let mut acl = vec![0u32; bytes.len().div_ceil(4)];
        // SAFETY: `acl` holds `bytes.len()` bytes; no overlap.
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), acl.as_mut_ptr().cast(), bytes.len());
        }
        let acl: *mut ACL = acl.as_mut_ptr().cast();
        // SAFETY: a valid ACL we own.
        let count = unsafe { (*acl).AceCount };
        for index in 0..u32::from(count) {
            let mut ace: *mut c_void = std::ptr::null_mut();
            // SAFETY: `index` is below the ACE count; every ACE starts with
            // an `ACE_HEADER`, whose flags we clear the inherited bit of.
            unsafe {
                assert_ne!(GetAce(acl, index, &mut ace), 0);
                let header = &mut (*ace.cast::<ACCESS_ALLOWED_ACE>()).Header;
                header.AceFlags &= !(INHERITED_ACE as u8);
            }
        }
        let wide = to_wide(path.as_os_str()).unwrap();
        write_dacl_only(&wide, acl, control).unwrap();
        assert_eq!(stored_dacl(path).0, control);
    }

    /// Granting an object and revoking the grant leaves its stored DACL
    /// exactly as it was, entries, flags and protection, for a protected, an
    /// explicit-only (legacy) and an auto-inherited DACL alike (#4263).
    #[test]
    fn grant_then_revoke_restores_the_stored_dacl_exactly() {
        let id = format!("appcontainer-exact-{}", std::process::id());
        let container = AppContainer::ensure(&id).unwrap();
        let tmp = tempfile::TempDir::new().unwrap();
        let legacy_dir = tmp.path().join("legacy");
        std::fs::create_dir(&legacy_dir).unwrap();
        make_explicit(&legacy_dir, 0);
        let legacy_file = tmp.path().join("legacy.exe");
        std::fs::write(&legacy_file, b"x").unwrap();
        make_explicit(&legacy_file, 0);
        let protected = tmp.path().join("protected.exe");
        std::fs::write(&protected, b"x").unwrap();
        make_explicit(&protected, SE_DACL_PROTECTED);
        let inherited = tmp.path().join("inherited");
        std::fs::create_dir(&inherited).unwrap();

        for path in [&legacy_dir, &legacy_file, &protected, &inherited] {
            let before = stored_dacl(path);
            container.grant_object(path, READ_EXECUTE).unwrap();
            let granted = stored_dacl(path);
            assert_eq!(
                granted.0,
                before.0,
                "the grant keeps `{}`'s control",
                path.display()
            );
            assert_ne!(
                granted.1,
                before.1,
                "the grant reaches `{}`",
                path.display()
            );
            let failures = delete_profile_revoking(&id, &[path.as_path()]).unwrap();
            assert!(failures.is_empty(), "{failures:?}");
            assert_eq!(
                stored_dacl(path),
                before,
                "`{}` is restored",
                path.display()
            );
        }
        delete_profile(&id).unwrap();
    }
}
