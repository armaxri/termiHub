//! Windows VcXsrv detection and guided, consent-based install via winget (#1318).
//!
//! Symmetric to the macOS [`super::macos`] path: termiHub detects VcXsrv and —
//! only on an explicit user action, never silently — installs it with `winget`
//! (`winget install -e --id marha.VcXsrv …`, the analog of `brew install --cask
//! xquartz`). When winget (App Installer) is absent, it returns a guided error so
//! the UI can point the user at the Microsoft Store, with a manual VcXsrv download
//! fallback. termiHub no longer hosts/redistributes a VcXsrv `.zip`, so the
//! GPL-3.0 redistribution burden of the old download path (#1076/#1056) is gone.
//!
//! Detection is a pure check over injectable paths so it is unit-testable on any
//! CI host; the install runs off the async reactor.

use std::path::PathBuf;

use anyhow::Result;

use super::types::XServerError;

/// Machine-scope VcXsrv install locations on Windows. winget's `marha.VcXsrv`
/// package (an NSIS installer, machine scope by default) installs the 64-bit
/// build to `C:\Program Files\VcXsrv`; the 32-bit / legacy tree uses `(x86)`.
const VCXSRV_MACHINE_PATHS: [&str; 2] = [
    r"C:\Program Files\VcXsrv\vcxsrv.exe",
    r"C:\Program Files (x86)\VcXsrv\vcxsrv.exe",
];

/// All candidate `vcxsrv.exe` locations, most-canonical first: the machine-scope
/// installs, a user-scope install under `%LOCALAPPDATA%\Programs\VcXsrv` (where a
/// winget user-scope install lands), and anything on `PATH`. Broadening beyond
/// the two `Program Files` paths keeps detection correct even if winget installs
/// to a non-default scope, so a just-succeeded install is never seen as missing.
fn candidate_paths() -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = VCXSRV_MACHINE_PATHS.iter().map(PathBuf::from).collect();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        paths.push(PathBuf::from(local).join(r"Programs\VcXsrv\vcxsrv.exe"));
    }
    if let Ok(on_path) = which::which("vcxsrv") {
        paths.push(on_path);
    }
    paths
}

/// The winget arguments that install VcXsrv. `winget` handles the UAC elevation
/// prompt itself, so the install stays consent-based. Mirrors
/// [`WINGET_INSTALL_VCXSRV_COMMAND`](super::types::WINGET_INSTALL_VCXSRV_COMMAND).
const WINGET_INSTALL_ARGS: [&str; 7] = [
    "install",
    "-e",
    "--id",
    "marha.VcXsrv",
    "--accept-package-agreements",
    "--accept-source-agreements",
    "-h",
];

/// Whether VcXsrv is installed at any candidate location.
pub(super) fn vcxsrv_installed() -> bool {
    super::any_path_exists(&candidate_paths())
}

/// Resolve the installed `vcxsrv.exe` path for the managed-server launcher.
///
/// Returns the first candidate location that exists; an `Err` (nothing installed)
/// makes the manager surface a launch failure rather than spawning a missing
/// binary. This is the production `resolver` the [`XServerManager`](super::manager::XServerManager)
/// uses, replacing the retired download-and-extract path.
pub(crate) fn resolve_vcxsrv_path() -> Result<PathBuf> {
    candidate_paths().into_iter().find(|p| p.exists()).ok_or_else(|| {
        anyhow::anyhow!(
            "VcXsrv is not installed (looked in {} and on PATH). Install it via the X Servers panel.",
            VCXSRV_MACHINE_PATHS.join(", ")
        )
    })
}

/// Guided, consent-based VcXsrv install (#1318).
///
/// Only ever called from the `x_server_install_dependency` command — i.e. after
/// an explicit user action, never on the silent connect path. Uses winget when
/// available (`winget install … marha.VcXsrv`, which prompts for UAC itself); when
/// winget is absent it returns [`XServerError::winget_required`] so the UI can
/// guide the user to install App Installer first (opening the Microsoft Store),
/// with a manual VcXsrv download fallback. Never installs anything silently.
pub(crate) async fn install_vcxsrv() -> Result<(), XServerError> {
    match decide_install_action(vcxsrv_installed(), super::binary_on_path("winget")) {
        InstallAction::AlreadyInstalled => Ok(()),
        InstallAction::InstallViaWinget => run_winget_install().await,
        // winget absent → guide the user to install App Installer (the UI opens
        // the Store), never a hosted/silent install (#1318).
        InstallAction::WingetRequired => Err(XServerError::winget_required()),
    }
}

/// What [`install_vcxsrv`] should do given the detected state. Pure over its
/// inputs so the branch is unit-testable without touching the real filesystem or
/// `PATH`, matching this module's injectable-detection style.
#[derive(Debug, PartialEq, Eq)]
enum InstallAction {
    /// VcXsrv is already present — nothing to do.
    AlreadyInstalled,
    /// VcXsrv missing but winget present — install the package automatically.
    InstallViaWinget,
    /// VcXsrv missing and winget absent — guide the user through installing App
    /// Installer first (#1318), rather than hosting a `.zip` or installing
    /// silently.
    WingetRequired,
}

/// Decide how to satisfy the VcXsrv dependency from the two detected booleans.
fn decide_install_action(vcxsrv_installed: bool, winget_present: bool) -> InstallAction {
    if vcxsrv_installed {
        InstallAction::AlreadyInstalled
    } else if winget_present {
        InstallAction::InstallViaWinget
    } else {
        InstallAction::WingetRequired
    }
}

/// Run `winget install … marha.VcXsrv` off the async reactor, mapping a spawn
/// failure or non-zero exit to a typed, display-ready error.
async fn run_winget_install() -> Result<(), XServerError> {
    tokio::task::spawn_blocking(|| {
        let output = std::process::Command::new("winget")
            .args(WINGET_INSTALL_ARGS)
            .output()
            .map_err(|e| XServerError::LaunchFailed {
                message: format!("Failed to run winget: {e}"),
            })?;
        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let detail = stderr
                .trim()
                .lines()
                .last()
                .unwrap_or("unknown error")
                .to_string();
            Err(XServerError::LaunchFailed {
                message: format!("winget failed to install VcXsrv: {detail}"),
            })
        }
    })
    .await
    .map_err(|e| XServerError::LaunchFailed {
        message: format!("VcXsrv install task failed: {e}"),
    })?
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Install decision (#1318) ─────────────────────────────────────────────
    //
    // `decide_install_action` is pure over its two detected booleans, so the
    // winget-absent → guided branch is unit-testable on any CI host without a
    // real VcXsrv / winget install (mirrors the macOS `decide_install_action`).

    #[test]
    fn already_installed_short_circuits_regardless_of_winget() {
        assert_eq!(
            decide_install_action(true, true),
            InstallAction::AlreadyInstalled
        );
        assert_eq!(
            decide_install_action(true, false),
            InstallAction::AlreadyInstalled
        );
    }

    #[test]
    fn missing_vcxsrv_with_winget_installs_via_winget() {
        assert_eq!(
            decide_install_action(false, true),
            InstallAction::InstallViaWinget
        );
    }

    #[test]
    fn missing_vcxsrv_without_winget_requires_app_installer_first() {
        // The core #1318 change: no winget → guide App Installer rather than a
        // dead-end "provisioning unavailable" error.
        assert_eq!(
            decide_install_action(false, false),
            InstallAction::WingetRequired
        );
    }

    #[test]
    fn machine_paths_are_the_documented_locations() {
        assert!(VCXSRV_MACHINE_PATHS
            .iter()
            .any(|p| p.ends_with(r"VcXsrv\vcxsrv.exe")));
        assert_eq!(VCXSRV_MACHINE_PATHS.len(), 2);
    }

    #[test]
    fn candidate_paths_include_the_machine_locations() {
        // The candidate list always contains the two machine-scope paths (plus,
        // at runtime, a user-scope path and any PATH hit).
        let candidates = candidate_paths();
        for machine in VCXSRV_MACHINE_PATHS {
            assert!(
                candidates.iter().any(|p| p.as_os_str() == machine),
                "candidate paths must include {machine}"
            );
        }
    }

    #[test]
    fn winget_args_target_the_vcxsrv_package() {
        assert!(WINGET_INSTALL_ARGS.contains(&"install"));
        assert!(WINGET_INSTALL_ARGS.contains(&"marha.VcXsrv"));
        assert!(WINGET_INSTALL_ARGS.contains(&"-h"), "silent flag");
    }
}
