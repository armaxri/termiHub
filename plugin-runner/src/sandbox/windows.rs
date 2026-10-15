//! Windows: verify the confinement the host started this runner in (#4187).
//!
//! A process cannot move itself into an AppContainer, so the host does the
//! confining: it creates the plugin's AppContainer profile, grants its SID the
//! runner, install and data folders, and starts the runner as a
//! **less-privileged** AppContainer (LPAC) with zero capabilities, the
//! child-process mitigation policy, and inside a kill-on-close job object
//! (`crate::appcontainer`, `crate::process`). The runner only checks, before
//! any plugin code is mapped, that this is really so:
//!
//! * its token is an AppContainer token with **no capabilities**;
//! * it is **less-privileged**: `HKCU\Software` (where other applications keep
//!   saved sessions) cannot be opened. A plain AppContainer can open it; LPAC
//!   cannot (spike #4181). This is a direct probe of the property that matters
//!   rather than a parse of the token's security attributes;
//! * it runs inside a job object (the memory and process limits live there).
//!
//! The first two make the [`APPCONTAINER`](super::layer::APPCONTAINER) layer
//! (required: without it the setup failed); the third the
//! [`JOB_OBJECT`](super::layer::JOB_OBJECT) layer (reported missing, i.e.
//! reduced isolation, when absent).

use std::io;
use std::os::windows::io::AsRawHandle;

use windows_sys::Win32::Foundation::{HANDLE, TRUE};
use windows_sys::Win32::Security::{
    GetTokenInformation, TokenCapabilities, TokenIsAppContainer, TOKEN_GROUPS, TOKEN_QUERY,
};
use windows_sys::Win32::System::JobObjects::IsProcessInJob;
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_READ,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

use super::{layer, SandboxError};
use crate::ipc::SandboxReport;
use crate::win::{owned, to_wide};

/// Check this process's confinement and report it.
pub fn verify() -> Result<SandboxReport, SandboxError> {
    let failed = |detail: String| SandboxError::Apply {
        layer: layer::APPCONTAINER,
        detail,
    };
    let token = Token::current().map_err(|e| failed(format!("opening the token: {e}")))?;
    if !token
        .is_app_container()
        .map_err(|e| failed(format!("reading the token: {e}")))?
    {
        return Err(failed(
            "the runner is not inside an AppContainer".to_owned(),
        ));
    }
    let capabilities = token
        .capability_count()
        .map_err(|e| failed(format!("reading the token capabilities: {e}")))?;
    if capabilities != 0 {
        return Err(failed(format!(
            "the AppContainer holds {capabilities} capabilities, expected none"
        )));
    }
    if can_open_hkcu_software() {
        return Err(failed(
            "HKCU\\Software is readable: not a less-privileged AppContainer".to_owned(),
        ));
    }
    let mut report = SandboxReport::enforced(&[layer::APPCONTAINER]);
    if in_job() {
        report.enforced.push(layer::JOB_OBJECT.to_owned());
    } else {
        report.missing.push(layer::JOB_OBJECT.to_owned());
    }
    Ok(report)
}

/// Whether `HKCU\Software` opens for reading (it must not under LPAC).
fn can_open_hkcu_software() -> bool {
    let Ok(subkey) = to_wide("Software".as_ref()) else {
        return false;
    };
    let mut key: HKEY = std::ptr::null_mut();
    // SAFETY: a predefined root key, a NUL-terminated subkey, and an
    // out-pointer for a key closed below.
    let status =
        unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, KEY_READ, &mut key) };
    if status != 0 {
        return false;
    }
    // SAFETY: the key opened above, closed once.
    unsafe { RegCloseKey(key) };
    true
}

/// Whether this process runs inside any job object.
fn in_job() -> bool {
    let mut result = 0;
    // SAFETY: the current-process pseudo handle; a NULL job asks about any.
    let ok = unsafe { IsProcessInJob(GetCurrentProcess(), std::ptr::null_mut(), &mut result) };
    ok != 0 && result == TRUE
}

/// This process's access token.
struct Token(std::os::windows::io::OwnedHandle);

impl Token {
    fn current() -> io::Result<Self> {
        let mut token: HANDLE = std::ptr::null_mut();
        // SAFETY: the current-process pseudo handle; `token` receives a new
        // handle owned below.
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(io::Error::last_os_error());
        }
        owned(token).map(Self)
    }

    fn is_app_container(&self) -> io::Result<bool> {
        let mut value = 0u32;
        let mut len = 0u32;
        // SAFETY: `value` is a writable `u32` of the size passed.
        let ok = unsafe {
            GetTokenInformation(
                self.0.as_raw_handle(),
                TokenIsAppContainer,
                std::ptr::from_mut(&mut value).cast(),
                std::mem::size_of::<u32>() as u32,
                &mut len,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(value != 0)
    }

    fn capability_count(&self) -> io::Result<u32> {
        let raw = self.0.as_raw_handle();
        let mut len = 0u32;
        // Sizing call: expected to fail with the needed length.
        // SAFETY: a null buffer of length 0 only queries the size.
        unsafe { GetTokenInformation(raw, TokenCapabilities, std::ptr::null_mut(), 0, &mut len) };
        if len == 0 {
            return Err(io::Error::last_os_error());
        }
        // `u64` storage keeps the `TOKEN_GROUPS` header pointer-aligned.
        let mut buf = vec![0u64; (len as usize).div_ceil(8)];
        // SAFETY: `buf` holds at least `len` writable bytes.
        let ok = unsafe {
            GetTokenInformation(
                raw,
                TokenCapabilities,
                buf.as_mut_ptr().cast(),
                len,
                &mut len,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the call filled `buf` with a `TOKEN_GROUPS` (aligned).
        Ok(unsafe { (*buf.as_ptr().cast::<TOKEN_GROUPS>()).GroupCount })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The test process itself is not an AppContainer: verification refuses
    /// it instead of reporting a sandbox that is not there.
    #[test]
    fn an_unconfined_process_fails_verification() {
        match verify() {
            Err(SandboxError::Apply {
                layer: failed,
                detail,
            }) => {
                assert_eq!(failed, layer::APPCONTAINER);
                assert!(detail.contains("not inside an AppContainer"), "{detail}");
            }
            other => panic!("expected an AppContainer failure, got {other:?}"),
        }
        // An ordinary process can read HKCU\Software: the LPAC probe is real.
        assert!(can_open_hkcu_software());
    }
}
