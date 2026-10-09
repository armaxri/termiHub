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
//! and `/dev/urandom`; the OpenSSL / LibreSSL CA bundle under `/private/etc/ssl`
//! (read only, plus the metadata of the `/etc` symlink, so `/etc/ssl/cert.pem`
//! resolves); `sysctl-read` of a fixed list of names ([`SYSCTL_NAMES`]);
//! process info and signals for itself only; `mach-lookup` of the per-user
//! certificate trust daemon `com.apple.trustd.agent` only (#4342);
//! `(deny network*)`, `(deny process-exec* process-fork)`, `(deny iokit-open)`;
//! an explicit deny of each denied folder (the user's home); then the install
//! folder read + map-exec and the data folder read/write. Seatbelt applies the
//! **last** matching rule, so the install and data allowances win inside a
//! denied home folder. No other `mach-lookup` rule is needed: dyld's shared
//! cache and libSystem are mapped before the profile is applied.
//!
//! **Default-allowed operations (#4342, SEC2-008).** `(deny default)` does not
//! cover every operation: on macOS 26, reading another process's information
//! (`proc_listallpids`, `proc_pidinfo`, `proc_pidpath` and, through an
//! unfiltered `sysctl-read`, `kern.proc.*` and `KERN_PROCARGS2` — the argv
//! and environment of the user's other processes) succeeded under the old
//! profile, although it only allowed `process-info*` for `(target self)`. The
//! profile therefore denies `process-info*` explicitly before allowing it for
//! itself, and narrows `sysctl-read` to named values; both are needed (either
//! alone still let `KERN_PROCARGS2` of the parent through).
//!
//! **Trust store (#4342, PLG2-004).** A plugin does TLS itself over the
//! socket the bridge passes in, so it must be able to verify certificates
//! against the system and the user's (corporate) roots. Security.framework
//! evaluates trust in `trustd`: allowing `mach-lookup` of
//! `com.apple.trustd.agent` makes `SecTrustEvaluateWithError` work (and with
//! it `rustls-platform-verifier`, `native-tls` and `security-framework`).
//! Anchor *enumeration* (`SecTrustCopyAnchorCertificates`,
//! `SecTrustSettingsCopyCertificates`, as `rustls-native-certs` does) also
//! needs `com.apple.SecurityServer` and the keychain files, which stay denied:
//! a plugin should evaluate trust through the platform verifier instead.
//!
//! **How the names were chosen.** Empirically, on macOS 26.5 (Apple
//! silicon): first every `sysctl-read` was allowed `(with report)` and the
//! runner, the escape-probe fixture and a Rust test program (tokio
//! multi-thread runtime, `available_parallelism`, `std_detect`, thread
//! spawning, large allocations) and a C program calling the libc functions
//! that read sysctls (`sysconf`, `uname`, `gethostname`, …) were run while
//! `log stream --predicate 'sender == "Sandbox"'` recorded every
//! `allow sysctl-read <name>`; then the narrowed profile was run the same way
//! and every `deny(1) sysctl-read <name>` was either added (e.g.
//! `hw.pagesize_compat`, which `sysconf(_SC_PAGESIZE)` reads) or left denied
//! (identifiers such as `kern.uuid`, `kern.boottime`, `hw.model`, and
//! `vm.loadavg`). `docs/plugin-authoring.md` lists the result.
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
(allow file-read* (subpath "/private/etc/ssl"))
(allow file-read-metadata (literal "/etc"))
(allow sysctl-read
  (sysctl-name
    "hw.activecpu" "hw.byteorder" "hw.cachelinesize" "hw.cachelinesize_compat"
    "hw.cpufamily" "hw.cpusubtype" "hw.cputype" "hw.l1dcachesize" "hw.l1icachesize"
    "hw.l2cachesize" "hw.l3cachesize" "hw.logicalcpu" "hw.logicalcpu_max" "hw.machine"
    "hw.memsize" "hw.ncpu" "hw.pagesize" "hw.pagesize_compat" "hw.physicalcpu"
    "hw.physicalcpu_max" "hw.tbfrequency" "hw.tbfrequency_compat" "kern.argmax"
    "kern.hostname" "kern.maxfilesperproc" "kern.osproductversion" "kern.osrelease"
    "kern.ostype" "kern.osvariant_status" "kern.osversion" "kern.usrstack64"
    "kern.version" "sysctl.proc_translated")
  (sysctl-name-prefix "hw.optional.")
  (sysctl-name-prefix "hw.perflevel"))
(deny process-info*)
(allow process-info* (target self))
(allow signal (target self))
(allow mach-lookup (global-name "com.apple.trustd.agent"))
(deny network*)
(deny process-exec* process-fork)
(deny iokit-open)
"#;

/// The `sysctl-read` names the profile allows exactly (see the module docs for
/// how they were chosen). Kept in sync with `PROFILE_HEAD` by a unit test.
pub const SYSCTL_NAMES: &[&str] = &[
    "hw.activecpu",
    "hw.byteorder",
    "hw.cachelinesize",
    "hw.cachelinesize_compat",
    "hw.cpufamily",
    "hw.cpusubtype",
    "hw.cputype",
    "hw.l1dcachesize",
    "hw.l1icachesize",
    "hw.l2cachesize",
    "hw.l3cachesize",
    "hw.logicalcpu",
    "hw.logicalcpu_max",
    "hw.machine",
    "hw.memsize",
    "hw.ncpu",
    "hw.pagesize",
    "hw.pagesize_compat",
    "hw.physicalcpu",
    "hw.physicalcpu_max",
    "hw.tbfrequency",
    "hw.tbfrequency_compat",
    "kern.argmax",
    "kern.hostname",
    "kern.maxfilesperproc",
    "kern.osproductversion",
    "kern.osrelease",
    "kern.ostype",
    "kern.osvariant_status",
    "kern.osversion",
    "kern.usrstack64",
    "kern.version",
    "sysctl.proc_translated",
];

/// The `sysctl-read` name prefixes the profile allows: CPU feature flags
/// (`std_detect`, ring, aws-lc, OpenSSL) and the per-performance-level CPU
/// counts.
pub const SYSCTL_NAME_PREFIXES: &[&str] = &["hw.optional.", "hw.perflevel"];

/// The only Mach service a plugin may look up: the per-user certificate trust
/// daemon, for `SecTrustEvaluateWithError` (#4342).
pub const TRUST_SERVICE: &str = "com.apple.trustd.agent";

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
