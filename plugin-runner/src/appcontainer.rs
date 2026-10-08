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
//! respawn does not touch the ACLs.
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
    CopySid, EqualSid, FreeSid, GetAce, GetLengthSid, GetSecurityDescriptorControl,
    InitializeSecurityDescriptor, SetFileSecurityW, SetSecurityDescriptorControl,
    SetSecurityDescriptorDacl, ACCESS_ALLOWED_ACE, ACE_FLAGS, ACL, DACL_SECURITY_INFORMATION,
    INHERITED_ACE, NO_INHERITANCE, PSECURITY_DESCRIPTOR, PSID, SECURITY_DESCRIPTOR,
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
        let current = Dacl::of(&wide)?;
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
    let wide = to_wide(app_container_name(plugin_id).as_ref())?;
    let _guard = PROFILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // SAFETY: NUL-terminated name.
    let hr = unsafe { DeleteAppContainerProfile(wide.as_ptr()) };
    // ERROR_FILE_NOT_FOUND / ERROR_PATH_NOT_FOUND / ERROR_NOT_FOUND: nothing
    // to delete.
    if [2, 3, 1168]
        .into_iter()
        .any(|code| hr == hresult_from_win32(code))
    {
        return Ok(());
    }
    check_hresult(hr, "DeleteAppContainerProfile")
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
}

impl Dacl {
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
        Ok(Self { descriptor, acl })
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
        // SAFETY: a valid ACL inside the descriptor we hold.
        let count = unsafe { (*self.acl).AceCount };
        (0..u32::from(count)).any(|index| {
            let mut ace: *mut c_void = std::ptr::null_mut();
            // SAFETY: `index` is below the ACE count.
            if unsafe { GetAce(self.acl, index, &mut ace) } == 0 {
                return false;
            }
            let ace = ace.cast::<ACCESS_ALLOWED_ACE>();
            // SAFETY: every ACE starts with an `ACE_HEADER`; the allowed-ACE
            // layout is only read once the type says it is one.
            let header = unsafe { (*ace).Header };
            if header.AceType != ACCESS_ALLOWED_ACE_TYPE
                || u32::from(header.AceFlags) & INHERITED_ACE != 0
                || u32::from(header.AceFlags) & inheritance != inheritance
            {
                return false;
            }
            // SAFETY: an allowed ACE: mask, then the SID at `SidStart`.
            let (mask, ace_sid) = unsafe {
                (
                    (*ace).Mask,
                    std::ptr::addr_of_mut!((*ace).SidStart).cast::<c_void>(),
                )
            };
            // SAFETY: both are valid SIDs.
            mask & access == access && unsafe { EqualSid(ace_sid, sid) } != 0
        })
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
        // SAFETY: allocated by `GetNamedSecurityInfoW`.
        unsafe { LocalFree(self.descriptor as HLOCAL) };
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
    // SAFETY: NUL-terminated path; a valid absolute descriptor.
    if unsafe { SetFileSecurityW(path.as_ptr(), DACL_SECURITY_INFORMATION, raw) } == 0 {
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
}
