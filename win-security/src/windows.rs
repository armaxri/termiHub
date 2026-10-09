//! The Win32 half: SID lookup, the owned protected descriptor, and DACL
//! read-back.

use std::ffi::c_void;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{FromRawHandle, OwnedHandle, RawHandle};
use std::path::Path;
use std::ptr;

use windows_sys::Win32::Foundation::{LocalFree, HANDLE, HLOCAL, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
    GetNamedSecurityInfoW, GetSecurityInfo, SetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT,
    SE_KERNEL_OBJECT,
};
use windows_sys::Win32::Security::{
    GetAce, GetSecurityDescriptorControl, GetSecurityDescriptorDacl, GetTokenInformation,
    TokenUser, ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, DACL_SECURITY_INFORMATION,
    PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES,
    SE_DACL_PROTECTED, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId;
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};

use crate::{dacl_sddl, Ace, DaclSpec, DaclSummary, ACCESS_ALLOWED_ACE_TYPE};

/// Take ownership of a handle a Win32 call just returned, turning the failure
/// sentinels (`NULL`, `INVALID_HANDLE_VALUE`) into the thread's last OS error.
fn owned(raw: HANDLE) -> io::Result<OwnedHandle> {
    if raw.is_null() || raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a fresh handle from a successful Win32 call; nothing else owns or
    // closes it.
    Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
}

/// The thread's last OS error when a Win32 `BOOL` call returned `FALSE`.
fn check_bool(ok: i32) -> io::Result<()> {
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// A `WIN32_ERROR` status as a result.
fn check_status(status: u32) -> io::Result<()> {
    if status == 0 {
        Ok(())
    } else {
        // Win32 error codes fit in an `i32`.
        Err(io::Error::from_raw_os_error(
            i32::try_from(status).unwrap_or(i32::MAX),
        ))
    }
}

/// `s` as a NUL-terminated UTF-16 string; an interior NUL is refused (Win32
/// would silently truncate there).
fn to_wide(s: &std::ffi::OsStr) -> io::Result<Vec<u16>> {
    let mut wide: Vec<u16> = s.encode_wide().collect();
    if wide.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "string contains an interior NUL",
        ));
    }
    wide.push(0);
    Ok(wide)
}

/// Frees a `LocalAlloc`ed block on drop.
struct LocalBox(*mut c_void);

impl Drop for LocalBox {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: a block the Win32 call that filled `self.0` allocated
            // with `LocalAlloc`; freed exactly once, here.
            unsafe { LocalFree(self.0 as HLOCAL) };
        }
    }
}

/// The current process user's SID in string form (e.g. `S-1-5-21-…`).
pub fn current_user_sid_string() -> io::Result<String> {
    let mut token: HANDLE = ptr::null_mut();
    // SAFETY: the pseudo handle of this process; `token` receives a new handle,
    // owned below.
    check_bool(unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) })?;
    let token = owned(token)?;
    // SAFETY: `token` is an open access token with `TOKEN_QUERY`.
    unsafe { sid_string_from_token(std::os::windows::io::AsRawHandle::as_raw_handle(&token)) }
}

/// The SID (string form) of the process on the client end of a connected
/// named-pipe server `pipe_handle` (AGT-022).
///
/// `GetNamedPipeClientProcessId` → `OpenProcess(QUERY_LIMITED_INFORMATION)` →
/// `OpenProcessToken(TOKEN_QUERY)` → `TokenUser`. Every handle is owned and
/// closed on every return path; any failure is an error, so a caller can choose
/// to fail open.
pub fn peer_sid_string(pipe_handle: RawHandle) -> io::Result<String> {
    let mut pid: u32 = 0;
    // SAFETY: a plain query on the caller's pipe handle into a local.
    check_bool(unsafe { GetNamedPipeClientProcessId(pipe_handle as HANDLE, &mut pid) })?;
    // SAFETY: no pointers; the returned handle is owned below.
    let process = owned(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) })?;
    let mut token: HANDLE = ptr::null_mut();
    // SAFETY: `process` is open with query access; `token` receives a new
    // handle, owned below.
    check_bool(unsafe {
        OpenProcessToken(
            std::os::windows::io::AsRawHandle::as_raw_handle(&process),
            TOKEN_QUERY,
            &mut token,
        )
    })?;
    let token = owned(token)?;
    // SAFETY: `token` is an open access token with `TOKEN_QUERY`.
    unsafe { sid_string_from_token(std::os::windows::io::AsRawHandle::as_raw_handle(&token)) }
}

/// The `TokenUser` SID of an open access token, as a string.
///
/// The `TOKEN_USER` buffer is held in `u64` storage so the header (which
/// contains a pointer) is properly aligned before it is read — the bug the
/// old core copy had (DUP2-004).
///
/// # Safety
/// `token` must be a valid open access token handle with `TOKEN_QUERY` access.
pub unsafe fn sid_string_from_token(token: RawHandle) -> io::Result<String> {
    let token = token as HANDLE;
    let mut len = 0u32;
    // Sizing call: expected to fail with the needed length.
    // SAFETY: a null buffer of length 0 only queries the size.
    unsafe { GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut len) };
    if len == 0 {
        return Err(io::Error::last_os_error());
    }
    // `u64` storage keeps the `TOKEN_USER` header pointer-aligned.
    let mut buf = vec![0u64; (len as usize).div_ceil(8)];
    // SAFETY: `buf` holds at least `len` writable bytes.
    check_bool(unsafe {
        GetTokenInformation(token, TokenUser, buf.as_mut_ptr().cast(), len, &mut len)
    })?;
    // SAFETY: the call filled `buf` with a `TOKEN_USER` (aligned, see above).
    let user = unsafe { &*buf.as_ptr().cast::<TOKEN_USER>() };
    // SAFETY: `user.User.Sid` points into `buf`, alive for the call.
    unsafe { sid_to_string(user.User.Sid) }
}

/// `sid` as `S-1-…`.
///
/// # Safety
/// `sid` must point to a valid SID.
pub unsafe fn sid_to_string(sid: PSID) -> io::Result<String> {
    let mut wide: *mut u16 = ptr::null_mut();
    // SAFETY: `sid` is valid (caller contract); `wide` receives a
    // `LocalAlloc`ed string, freed by the guard.
    check_bool(unsafe { ConvertSidToStringSidW(sid, &mut wide) })?;
    let _guard = LocalBox(wide.cast());
    let mut chars = 0usize;
    // SAFETY: `wide` is a NUL-terminated string.
    let text = unsafe {
        while *wide.add(chars) != 0 {
            chars += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(wide, chars))
    };
    Ok(text)
}

/// A protected DACL granting `GENERIC_ALL` only to the current user (and the
/// [`DaclSpec`]'s extra principals), owned together with the non-inheritable
/// `SECURITY_ATTRIBUTES` that reference it.
///
/// The descriptor is freed on drop, so the attributes must not outlive this
/// value; pass [`Self::security_attributes`] to the create call while `self`
/// is alive.
pub struct ProtectedDacl {
    descriptor: PSECURITY_DESCRIPTOR,
    attributes: SECURITY_ATTRIBUTES,
}

// SAFETY: the descriptor is an immutable, exclusively owned `LocalAlloc` block
// and `attributes` only points into it; nothing about it is thread-affine.
unsafe impl Send for ProtectedDacl {}
// SAFETY: as above — shared access only reads the block.
unsafe impl Sync for ProtectedDacl {}

impl ProtectedDacl {
    /// A protected DACL for the current user plus whatever `spec` adds.
    pub fn new(spec: &DaclSpec<'_>) -> io::Result<Self> {
        let sddl = dacl_sddl(&current_user_sid_string()?, spec)?;
        let wide = to_wide(sddl.as_ref())?;
        let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
        // SAFETY: `wide` is NUL-terminated; `descriptor` receives a
        // `LocalAlloc`ed descriptor freed on drop.
        check_bool(unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                ptr::null_mut(),
            )
        })?;
        Ok(Self {
            descriptor,
            attributes: SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor,
                bInheritHandle: 0,
            },
        })
    }

    /// The current user and `LocalSystem` only
    /// ([`DaclSpec::CURRENT_USER_AND_SYSTEM`]).
    pub fn current_user_and_system() -> io::Result<Self> {
        Self::new(&DaclSpec::CURRENT_USER_AND_SYSTEM)
    }

    /// The `SECURITY_ATTRIBUTES` for a create call (`CreateNamedPipeW`,
    /// `CreateDirectoryW`, tokio's `create_with_security_attributes_raw`), valid
    /// while `self` is alive.
    pub fn security_attributes(&self) -> *const SECURITY_ATTRIBUTES {
        &self.attributes
    }

    /// The owned self-relative security descriptor.
    pub fn descriptor(&self) -> PSECURITY_DESCRIPTOR {
        self.descriptor
    }

    /// Read this descriptor's DACL back.
    pub fn summary(&self) -> io::Result<DaclSummary> {
        // SAFETY: `self.descriptor` is a valid descriptor owned by `self`.
        unsafe { dacl_of_descriptor(self.descriptor) }
    }

    /// Replace the DACL of the existing file or directory `path` with this one,
    /// protected so nothing is inherited from the parent.
    pub fn apply_to_path(&self, path: &Path) -> io::Result<()> {
        let wide = to_wide(path.as_os_str())?;
        let (mut present, mut defaulted) = (0, 0);
        let mut acl: *mut ACL = ptr::null_mut();
        // SAFETY: a valid descriptor owned by `self`; writable out-pointers.
        // `acl` points into the descriptor, alive for the call below.
        check_bool(unsafe {
            GetSecurityDescriptorDacl(self.descriptor, &mut present, &mut acl, &mut defaulted)
        })?;
        if present == 0 || acl.is_null() {
            // Never happens for an SDDL with a `D:` part; refuse rather than
            // write a NULL DACL (which grants everyone everything).
            return Err(io::Error::other("descriptor carries no DACL"));
        }
        // SAFETY: NUL-terminated path; `acl` is a valid ACL inside `self`.
        check_status(unsafe {
            SetNamedSecurityInfoW(
                wide.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                acl,
                ptr::null(),
            )
        })
    }
}

impl Drop for ProtectedDacl {
    fn drop(&mut self) {
        // SAFETY: allocated by `ConvertStringSecurityDescriptorToSecurityDescriptorW`.
        unsafe { LocalFree(self.descriptor as HLOCAL) };
    }
}

/// Read the DACL of a security descriptor.
///
/// # Safety
/// `descriptor` must point to a valid security descriptor.
pub unsafe fn dacl_of_descriptor(descriptor: PSECURITY_DESCRIPTOR) -> io::Result<DaclSummary> {
    let mut control = 0u16;
    let mut revision = 0u32;
    // SAFETY: a valid descriptor (caller contract); writable out-pointers.
    check_bool(unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) })?;
    let (mut present, mut defaulted) = (0, 0);
    let mut acl: *mut ACL = ptr::null_mut();
    // SAFETY: as above.
    check_bool(unsafe {
        GetSecurityDescriptorDacl(descriptor, &mut present, &mut acl, &mut defaulted)
    })?;
    let present = present != 0 && !acl.is_null();
    let mut aces = Vec::new();
    if present {
        // SAFETY: a valid ACL inside the descriptor.
        let count = unsafe { (*acl).AceCount };
        for index in 0..u32::from(count) {
            let mut ace: *mut c_void = ptr::null_mut();
            // SAFETY: `index` is below the ACE count.
            check_bool(unsafe { GetAce(acl, index, &mut ace) })?;
            // SAFETY: every ACE starts with an `ACE_HEADER`; ACEs are
            // DWORD-aligned inside an ACL.
            let header = unsafe { ptr::read_unaligned(ace.cast::<ACE_HEADER>()) };
            let (mask, sid) = if header.AceType == ACCESS_ALLOWED_ACE_TYPE {
                let allowed = ace.cast::<ACCESS_ALLOWED_ACE>();
                // SAFETY: an access-allowed ACE: header, mask, then the SID
                // starting at `SidStart`.
                let (mask, sid_ptr) = unsafe {
                    (
                        ptr::read_unaligned(ptr::addr_of!((*allowed).Mask)),
                        ptr::addr_of_mut!((*allowed).SidStart).cast::<c_void>(),
                    )
                };
                // SAFETY: `sid_ptr` is the ACE's valid SID.
                (mask, Some(unsafe { sid_to_string(sid_ptr) }?))
            } else {
                // Every ACE type puts its mask right after the header.
                // SAFETY: the ACE is at least header + mask long.
                let mask = unsafe { ptr::read_unaligned(ace.cast::<u8>().add(4).cast::<u32>()) };
                (mask, None)
            };
            aces.push(Ace {
                ace_type: header.AceType,
                flags: header.AceFlags,
                mask,
                sid,
            });
        }
    }
    Ok(DaclSummary {
        protected: control & SE_DACL_PROTECTED != 0,
        present,
        aces,
    })
}

/// Read the DACL of the object behind an open handle (a named pipe, file,
/// directory, …). The handle needs `READ_CONTROL` access.
pub fn dacl_of_handle(handle: RawHandle) -> io::Result<DaclSummary> {
    let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
    // SAFETY: the caller's open handle; the out-pointer receives a
    // `LocalAlloc`ed descriptor freed by the guard.
    check_status(unsafe {
        GetSecurityInfo(
            handle as HANDLE,
            SE_KERNEL_OBJECT,
            DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            &mut descriptor,
        )
    })?;
    let _guard = LocalBox(descriptor);
    // SAFETY: a valid descriptor, alive until the guard drops.
    unsafe { dacl_of_descriptor(descriptor) }
}

/// Read the DACL of the file or directory at `path`.
pub fn dacl_of_path(path: &Path) -> io::Result<DaclSummary> {
    let wide = to_wide(path.as_os_str())?;
    let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
    // SAFETY: NUL-terminated path; the out-pointer receives a `LocalAlloc`ed
    // descriptor freed by the guard.
    check_status(unsafe {
        GetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            &mut descriptor,
        )
    })?;
    let _guard = LocalBox(descriptor);
    // SAFETY: a valid descriptor, alive until the guard drops.
    unsafe { dacl_of_descriptor(descriptor) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{LOCAL_SYSTEM_SID, OBJECT_AND_CONTAINER_INHERIT};
    use std::os::windows::io::AsRawHandle;

    #[test]
    fn the_current_user_sid_resolves() {
        let sid = current_user_sid_string().expect("current user SID");
        assert!(crate::is_sid_string(&sid), "{sid}");
    }

    /// DUP2-004: the token's SID read through the aligned buffer equals the one
    /// read straight off this process's token, run repeatedly so an
    /// under-aligned read would have a chance to show.
    #[test]
    fn the_sid_from_an_explicit_token_matches_the_current_user() {
        let expected = current_user_sid_string().unwrap();
        for _ in 0..32 {
            let mut token: HANDLE = ptr::null_mut();
            // SAFETY: pseudo handle of this process; `token` is owned below.
            check_bool(unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) })
                .unwrap();
            let token = owned(token).unwrap();
            // SAFETY: an open token with `TOKEN_QUERY`.
            let sid = unsafe { sid_string_from_token(token.as_raw_handle()) }.unwrap();
            assert_eq!(sid, expected);
        }
    }

    #[test]
    fn the_current_user_and_system_descriptor_is_protected_with_exactly_two_aces() {
        let user = current_user_sid_string().unwrap();
        let dacl = ProtectedDacl::current_user_and_system().unwrap();
        let summary = dacl.summary().unwrap();
        assert!(summary.protected, "{summary:?}");
        assert!(summary.present, "{summary:?}");
        assert_eq!(summary.aces.len(), 2, "{summary:?}");
        assert_eq!(summary.aces[0].sid.as_deref(), Some(user.as_str()));
        assert_eq!(summary.aces[1].sid.as_deref(), Some(LOCAL_SYSTEM_SID));
        for ace in &summary.aces {
            assert_eq!(ace.ace_type, ACCESS_ALLOWED_ACE_TYPE);
            assert_eq!(ace.mask, crate::GENERIC_ALL);
            assert_eq!(ace.flags, 0);
        }
        assert!(summary.grants_full_control_to_exactly(&[&user, LOCAL_SYSTEM_SID]));
        // The attributes point at the owned descriptor and are not inheritable.
        // SAFETY: valid while `dacl` lives.
        let attributes = unsafe { &*dacl.security_attributes() };
        assert_eq!(attributes.lpSecurityDescriptor, dacl.descriptor());
        assert_eq!(attributes.bInheritHandle, 0);
    }

    #[test]
    fn a_descriptor_without_system_grants_only_the_user_and_the_extras() {
        let user = current_user_sid_string().unwrap();
        let extra = "S-1-15-2-1-2-3-4-5-6-7";
        let dacl = ProtectedDacl::new(&DaclSpec {
            extra_sids: &[extra],
            ..DaclSpec::default()
        })
        .unwrap();
        let summary = dacl.summary().unwrap();
        assert!(
            summary.grants_full_control_to_exactly(&[&user, extra]),
            "{summary:?}"
        );
    }

    #[test]
    fn applying_to_a_directory_replaces_its_inherited_dacl() {
        let user = current_user_sid_string().unwrap();
        let parent = tempfile::tempdir().unwrap();
        let dir = parent.path().join("private");
        std::fs::create_dir(&dir).unwrap();
        // Freshly created: an unprotected DACL inherited from the temp dir.
        assert!(!dacl_of_path(&dir).unwrap().protected);

        let dacl = ProtectedDacl::new(&DaclSpec {
            include_system: true,
            inherit_to_children: true,
            ..DaclSpec::default()
        })
        .unwrap();
        dacl.apply_to_path(&dir).unwrap();

        let summary = dacl_of_path(&dir).unwrap();
        assert!(
            summary.grants_full_control_to_exactly(&[&user, LOCAL_SYSTEM_SID]),
            "{summary:?}"
        );
        assert!(summary
            .aces
            .iter()
            .all(|ace| ace.flags & OBJECT_AND_CONTAINER_INHERIT == OBJECT_AND_CONTAINER_INHERIT));

        // A file created inside inherits exactly those grants.
        let file = dir.join("staged.bin");
        std::fs::write(&file, b"x").unwrap();
        let inner = dacl_of_path(&file).unwrap();
        let sids: Vec<_> = inner.aces.iter().filter_map(|a| a.sid.as_deref()).collect();
        assert_eq!(inner.aces.len(), 2, "{inner:?}");
        assert!(sids.contains(&user.as_str()) && sids.contains(&LOCAL_SYSTEM_SID));
    }

    #[test]
    fn a_pipe_created_with_the_attributes_carries_the_dacl() {
        use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
        use windows_sys::Win32::System::Pipes::{CreateNamedPipeW, PIPE_TYPE_BYTE, PIPE_WAIT};

        let user = current_user_sid_string().unwrap();
        let dacl = ProtectedDacl::current_user_and_system().unwrap();
        let name = format!(
            r"\\.\pipe\termihub-win-security-test-{}",
            std::process::id()
        );
        let wide = to_wide(name.as_ref()).unwrap();
        // SAFETY: NUL-terminated name; the attributes outlive the call.
        let pipe = owned(unsafe {
            CreateNamedPipeW(
                wide.as_ptr(),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_WAIT,
                1,
                512,
                512,
                0,
                dacl.security_attributes(),
            )
        })
        .unwrap();
        let summary = dacl_of_handle(pipe.as_raw_handle()).unwrap();
        assert!(
            summary.grants_full_control_to_exactly(&[&user, LOCAL_SYSTEM_SID]),
            "{summary:?}"
        );
    }
}
