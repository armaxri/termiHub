//! The OS-neutral sandbox contract shared by the host and the runner (plugin
//! OS-sandbox phases 4–5, concept `docs/concepts/backlog/plugin-os-sandbox.html`).
//!
//! * [`SandboxPolicy`] — what one plugin's runner may touch, derived by the host
//!   from the plugin's install and data folders and sent in `Configure`. It is
//!   deliberately small: the install folder read-only (plus map-exec), the data
//!   folder read/write, and nothing else. The runner gets **no network**: a
//!   plugin reaches the network only through the capability bridge, where the
//!   host opens the socket and passes the connected descriptor in.
//! * [`SandboxReport`] — what the runner actually
//!   enforced, sent before any plugin code is mapped; [`Isolation`] classifies
//!   it and [`layer`] names the layers.
//! * [`apply`] — the per-OS confinement of the calling process: Seatbelt on
//!   macOS ([`macos`], #4186), no_new_privs + landlock + seccomp on Linux
//!   (`linux`, #4185), whose `EPERM` denials are reported to the host
//!   ([`denial`], #4236). Windows (LPAC + job object, #4187) plugs in here and
//!   reports through the same type.
//!
//! The runner applies the policy to **itself** after it opened its IPC channel
//! and pinned the plugin library, and before `dlopen`, so every byte of plugin
//! code runs confined. A policy that cannot be applied is reported as failed
//! and the plugin is never loaded (there is no fallback to running unconfined).

pub mod denial;
#[cfg(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
pub mod linux;
pub mod macos;
#[cfg(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
pub mod sigsys;

use serde::{Deserialize, Serialize};

use crate::ipc::SandboxReport;

/// Names of the confinement layers a [`SandboxReport`] lists.
pub mod layer {
    /// macOS Seatbelt profile applied with `sandbox_init_with_parameters`.
    pub const SEATBELT: &str = "seatbelt";
    /// Linux landlock filesystem ruleset (#4185).
    pub const LANDLOCK: &str = "landlock";
    /// Linux seccomp-bpf system-call filter (#4185).
    pub const SECCOMP: &str = "seccomp";
    /// Linux unprivileged user + network + IPC namespace (#4237). Optional
    /// defence in depth: listed as enforced where the system allows
    /// unprivileged user namespaces, never listed as missing and never
    /// required, so it does not change the [`Isolation`](super::Isolation)
    /// class.
    pub const NETNS: &str = "netns";
    /// Windows Less-Privileged AppContainer (#4187).
    pub const APPCONTAINER: &str = "appcontainer";
    /// Windows job object (#4187).
    pub const JOB_OBJECT: &str = "job-object";
}

/// The confinement layers the host requires on this platform. A runner whose
/// report lacks one of them is treated as a failed setup and its plugin is not
/// loaded. Platforms whose sandbox phase has not landed yet require nothing.
///
/// On Linux only seccomp is required: a kernel without landlock (< 5.13) runs
/// the plugin with **reduced** isolation (landlock listed as missing), which
/// the host gates behind the `reducedIsolationAccepted` acknowledgement.
#[must_use]
pub fn required_layers() -> &'static [&'static str] {
    if cfg!(target_os = "macos") {
        &[layer::SEATBELT]
    } else if cfg!(target_os = "linux") {
        &[layer::SECCOMP]
    } else {
        &[]
    }
}

/// Environment variable (read by the **host**, debug builds only) naming
/// layers the runner should pretend are unavailable, comma-separated — e.g.
/// `landlock` forces the reduced-isolation path on any kernel. It reaches the
/// runner as [`SandboxPolicy::simulate_missing`].
pub const SIMULATE_MISSING_ENV: &str = "TERMIHUB_SANDBOX_SIMULATE_MISSING";

/// What one plugin's runner may access (host → runner, in `Configure`).
///
/// Every path is absolute and **canonical** (symlinks resolved by the host):
/// the kernel matches the resolved path, so `/var/…` on macOS must already be
/// `/private/var/…`. Paths reach the OS mechanism as data (Seatbelt parameters,
/// landlock path descriptors, ACL entries), never spliced into policy text.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxPolicy {
    /// The plugin's install folder (manifest, backend library): read and
    /// map-executable, never writable.
    pub install_dir: String,
    /// The plugin's private data folder: read and write. The runner points
    /// `HOME` and `TMPDIR` at it. It may not exist yet (the host creates it
    /// only for plugins that use it). `None` grants no writable folder.
    #[serde(default)]
    pub data_dir: Option<String>,
    /// Folders denied explicitly even where a broader allowance would reach
    /// them (the user's home folder). The install and data folders stay
    /// reachable when they lie inside one of these.
    #[serde(default)]
    pub denied_dirs: Vec<String>,
    /// Test hook: layers the runner must treat as unavailable on this system
    /// (`landlock` and `netns` are understood, on Linux), to exercise the
    /// reduced-isolation path and the no-namespace path on any kernel. Set by a debug-build host from
    /// [`SIMULATE_MISSING_ENV`]; a release-build runner ignores it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub simulate_missing: Vec<String>,
}

/// Why a [`SandboxPolicy`] was refused or could not be applied.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SandboxError {
    /// A policy path is empty, relative, contains a NUL byte, or names the
    /// filesystem root.
    #[error("sandbox policy path `{path}` is invalid: {reason}")]
    InvalidPath {
        /// The offending path, verbatim.
        path: String,
        /// What is wrong with it.
        reason: &'static str,
    },
    /// The OS refused to apply the confinement.
    #[error("applying the {layer} sandbox failed: {detail}")]
    Apply {
        /// The layer that failed ([`layer`]).
        layer: &'static str,
        /// The OS's error text.
        detail: String,
    },
}

impl SandboxPolicy {
    /// Check that every path is usable: absolute, non-empty, free of NUL bytes,
    /// and not the filesystem root (which would grant or deny everything).
    pub fn validate(&self) -> Result<(), SandboxError> {
        let check = |path: &str| -> Result<(), SandboxError> {
            let invalid = |reason| SandboxError::InvalidPath {
                path: path.to_owned(),
                reason,
            };
            if path.is_empty() {
                return Err(invalid("empty"));
            }
            if path.contains('\0') {
                return Err(invalid("contains a NUL byte"));
            }
            let p = std::path::Path::new(path);
            if !p.is_absolute() {
                return Err(invalid("not absolute"));
            }
            if p.parent().is_none() {
                return Err(invalid("is the filesystem root"));
            }
            Ok(())
        };
        check(&self.install_dir)?;
        if let Some(data) = &self.data_dir {
            check(data)?;
        }
        self.denied_dirs.iter().try_for_each(|d| check(d))
    }
}

/// How well a runner is isolated, judged from its [`SandboxReport`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Isolation {
    /// Every requested layer is enforced.
    Full,
    /// Some layers are enforced, others are missing on this system (needs the
    /// `reducedIsolationAccepted` acknowledgement once the gate lands).
    Reduced,
    /// Nothing is enforced: no policy was requested, or this platform's
    /// sandbox phase has not landed yet.
    Unconfined,
    /// Setting the sandbox up failed; the plugin must not load.
    Failed,
}

impl SandboxReport {
    /// A report of `enforced` layers with nothing missing.
    #[must_use]
    pub fn enforced(layers: &[&str]) -> Self {
        Self {
            enforced: layers.iter().map(|l| (*l).to_owned()).collect(),
            ..Self::default()
        }
    }

    /// A report of a failed setup.
    #[must_use]
    pub fn setup_failed(error: &SandboxError) -> Self {
        Self {
            failed: Some(error.to_string()),
            ..Self::default()
        }
    }

    /// Classify the report.
    #[must_use]
    pub fn isolation(&self) -> Isolation {
        if self.failed.is_some() {
            Isolation::Failed
        } else if self.enforced.is_empty() {
            Isolation::Unconfined
        } else if self.missing.is_empty() {
            Isolation::Full
        } else {
            Isolation::Reduced
        }
    }

    /// The first of `required` layers this report does not list as enforced.
    #[must_use]
    pub fn missing_required<'a>(&self, required: &[&'a str]) -> Option<&'a str> {
        required
            .iter()
            .copied()
            .find(|layer| !self.enforced.iter().any(|e| e == layer))
    }
}

/// Confine the calling process to `policy` with this platform's mechanism and
/// report what was enforced. Call it once, after the IPC channel is open and
/// the plugin library is pinned, and before `dlopen`.
///
/// On a platform whose sandbox phase has not landed yet this applies nothing
/// and returns an empty (unconfined) report.
#[must_use]
pub fn apply(policy: &SandboxPolicy) -> SandboxReport {
    match apply_os(policy) {
        Ok(report) => report,
        Err(error) => SandboxReport::setup_failed(&error),
    }
}

#[cfg(target_os = "macos")]
fn apply_os(policy: &SandboxPolicy) -> Result<SandboxReport, SandboxError> {
    policy.validate()?;
    macos::apply(policy)?;
    Ok(SandboxReport::enforced(&[layer::SEATBELT]))
}

#[cfg(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
fn apply_os(policy: &SandboxPolicy) -> Result<SandboxReport, SandboxError> {
    policy.validate()?;
    let simulated =
        |name: &str| cfg!(debug_assertions) && policy.simulate_missing.iter().any(|l| l == name);
    let skip = linux::Skip {
        landlock: simulated(layer::LANDLOCK),
        namespaces: simulated(layer::NETNS),
    };
    linux::apply(policy, skip)
}

/// Linux on an architecture the seccomp filter has no syscall table for:
/// fail closed (the runner ships for x86_64 and aarch64 only).
#[cfg(all(
    target_os = "linux",
    not(any(target_arch = "x86_64", target_arch = "aarch64"))
))]
fn apply_os(policy: &SandboxPolicy) -> Result<SandboxReport, SandboxError> {
    policy.validate()?;
    Err(SandboxError::Apply {
        layer: layer::SECCOMP,
        detail: format!("no seccomp filter for {}", std::env::consts::ARCH),
    })
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn apply_os(policy: &SandboxPolicy) -> Result<SandboxReport, SandboxError> {
    // Windows (#4187) applies its layers here.
    policy.validate()?;
    Ok(SandboxReport::default())
}

/// Drain the system-call denials counted since the last call into
/// `Denied{syscall}` log frames (#4236; see [`denial`]). Empty where the
/// sandbox does not trap denials (every platform but Linux).
#[must_use]
pub fn take_denial_reports() -> Vec<crate::ipc::Log> {
    #[cfg(all(
        target_os = "linux",
        any(target_arch = "x86_64", target_arch = "aarch64")
    ))]
    return denial::reports(sigsys::take());
    #[cfg(not(all(
        target_os = "linux",
        any(target_arch = "x86_64", target_arch = "aarch64")
    )))]
    Vec::new()
}

#[cfg(test)]
mod tests;
