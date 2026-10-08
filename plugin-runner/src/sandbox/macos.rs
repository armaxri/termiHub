//! macOS: a Seatbelt profile generated from a [`SandboxPolicy`] and applied to
//! the calling process with `sandbox_init_with_parameters` (#4186).
//!
//! Mechanism chosen in the phase-0 spike (#4181): a hand-written FFI wrapper.
//! `birdcage` was rejected (GPL-3.0-or-later, a spawn-a-child API instead of
//! confining the caller, and a base profile that allows `mach*`, `ipc*`,
//! `sysctl*` and `process-fork`). The API is formally private but has been
//! stable for over a decade and is what Chromium, Firefox and WebKit confine
//! their renderers with; it needs no code signature or entitlement, so it works
//! for the unsigned beta.
//!
//! **Escaping.** The profile text is a constant shape: it never contains a
//! path. Every path is passed as a Seatbelt *parameter* and referenced as
//! `(param "NAME")`, so quotes, parentheses or other SBPL syntax in a folder
//! name cannot change the profile. The generator ([`seatbelt_profile`]) is
//! pure and compiled on every OS so its unit tests run everywhere.
//!
//! **Rules.** `(deny default)`; read + map-exec of the system libraries
//! (`/usr/lib`, `/System/Library`, the OS cryptexes); `/dev/null`, `/dev/random`
//! and `/dev/urandom`; `sysctl-read`; process info and signals for itself only;
//! `(deny network*)`, `(deny process-exec* process-fork)`, `(deny iokit-open)`;
//! an explicit deny of each denied folder (the user's home); then the install
//! folder read + map-exec and the data folder read/write. Seatbelt applies the
//! **last** matching rule, so the install and data allowances win inside a
//! denied home folder. No `mach-lookup` rule is needed: dyld's shared cache and
//! libSystem are mapped before the profile is applied.
//!
//! Descriptors opened before the profile was applied keep working: the IPC
//! socket, the pinned library handle and the connected sockets the host passes
//! with bridge replies (`SCM_RIGHTS`). What is denied is *creating* access —
//! opening paths, `socket` + `connect` / `bind`, DNS, `fork`, `exec`.

use super::{SandboxError, SandboxPolicy};

/// Parameter naming the install folder.
pub const PARAM_INSTALL_DIR: &str = "INSTALL_DIR";
/// Parameter naming the data folder.
pub const PARAM_DATA_DIR: &str = "DATA_DIR";
/// Prefix of the parameters naming denied folders (`DENIED_DIR_0`, …).
pub const PARAM_DENIED_DIR_PREFIX: &str = "DENIED_DIR_";

/// The fixed head of every profile: deny everything, then allow what the
/// runner's own process needs to keep running.
const PROFILE_HEAD: &str = r#"(version 1)
(deny default)
(allow file-read* file-map-executable
  (subpath "/usr/lib")
  (subpath "/System/Library")
  (subpath "/System/Cryptexes/OS")
  (subpath "/System/Volumes/Preboot/Cryptexes/OS"))
(allow file-read* (literal "/dev/urandom") (literal "/dev/random"))
(allow file-read* file-write-data (literal "/dev/null"))
(allow sysctl-read)
(allow process-info* (target self))
(allow signal (target self))
(deny network*)
(deny process-exec* process-fork)
(deny iokit-open)
"#;

/// A generated profile: SBPL text plus the parameters it references.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeatbeltProfile {
    /// The SBPL profile. Contains no path; see the module docs.
    pub sbpl: String,
    /// `(name, value)` pairs for `sandbox_init_with_parameters`.
    pub params: Vec<(String, String)>,
}

/// Generate the Seatbelt profile for `policy`. Validates the policy first.
pub fn seatbelt_profile(policy: &SandboxPolicy) -> Result<SeatbeltProfile, SandboxError> {
    policy.validate()?;
    let mut sbpl = String::from(PROFILE_HEAD);
    let mut params = Vec::new();
    for (i, dir) in policy.denied_dirs.iter().enumerate() {
        let name = format!("{PARAM_DENIED_DIR_PREFIX}{i}");
        sbpl.push_str(&format!("(deny file* (subpath (param \"{name}\")))\n"));
        params.push((name, dir.clone()));
    }
    sbpl.push_str(&format!(
        "(allow file-read* file-map-executable (subpath (param \"{PARAM_INSTALL_DIR}\")))\n"
    ));
    params.push((PARAM_INSTALL_DIR.to_owned(), policy.install_dir.clone()));
    if let Some(data) = &policy.data_dir {
        sbpl.push_str(&format!(
            "(allow file-read* file-write* (subpath (param \"{PARAM_DATA_DIR}\")))\n"
        ));
        params.push((PARAM_DATA_DIR.to_owned(), data.clone()));
    }
    Ok(SeatbeltProfile { sbpl, params })
}

/// Confine the calling process to `policy`. Irreversible: there is no way to
/// lift a Seatbelt profile once applied.
#[cfg(target_os = "macos")]
pub fn apply(policy: &SandboxPolicy) -> Result<(), SandboxError> {
    use std::ffi::{c_char, c_int, CStr, CString};

    extern "C" {
        // libsystem_sandbox (part of libSystem, linked by default):
        // `int sandbox_init_with_parameters(const char *profile,
        //     uint64_t flags, const char *const parameters[], char **errorbuf);`
        // `parameters` is a NULL-terminated list of alternating names and
        // values; flags `0` means `profile` is SBPL text.
        fn sandbox_init_with_parameters(
            profile: *const c_char,
            flags: u64,
            parameters: *const *const c_char,
            errorbuf: *mut *mut c_char,
        ) -> c_int;
        fn sandbox_free_error(errorbuf: *mut c_char);
    }

    let failed = |detail: String| SandboxError::Apply {
        layer: super::layer::SEATBELT,
        detail,
    };
    let profile = seatbelt_profile(policy)?;
    // `validate` already refused NUL bytes in paths; names and the profile are
    // ours. Map defensively anyway.
    let nul = |_| failed("a profile string contains a NUL byte".to_owned());
    let sbpl = CString::new(profile.sbpl).map_err(nul)?;
    let strings = profile
        .params
        .into_iter()
        .flat_map(|(name, value)| [name, value])
        .map(CString::new)
        .collect::<Result<Vec<_>, _>>()
        .map_err(nul)?;
    let mut pointers: Vec<*const c_char> = strings.iter().map(|s| s.as_ptr()).collect();
    pointers.push(std::ptr::null());

    let mut error: *mut c_char = std::ptr::null_mut();
    // SAFETY: `sbpl` and every parameter string are valid NUL-terminated
    // strings that outlive the call; `pointers` is NULL-terminated; `error`
    // is a valid out-pointer the call may set to a string we free below.
    let rc =
        unsafe { sandbox_init_with_parameters(sbpl.as_ptr(), 0, pointers.as_ptr(), &mut error) };
    if rc == 0 {
        return Ok(());
    }
    let detail = if error.is_null() {
        format!("sandbox_init_with_parameters returned {rc}")
    } else {
        // SAFETY: on failure `error` points to a NUL-terminated string owned
        // by libsandbox until `sandbox_free_error`.
        let text = unsafe { CStr::from_ptr(error) }
            .to_string_lossy()
            .into_owned();
        // SAFETY: `error` came from `sandbox_init_with_parameters`.
        unsafe { sandbox_free_error(error) };
        text
    };
    Err(failed(detail))
}
