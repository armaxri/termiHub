//! macOS XQuartz detection and guided, consent-based install (#1054).
//!
//! macOS can't embed an X server, so termiHub detects XQuartz and — only on an
//! explicit user action, never silently — guides its install: `brew install
//! --cask xquartz` when Homebrew is present, otherwise actionable guidance to
//! download it from xquartz.org (the hosted notarized `.pkg` path is a
//! follow-up). Detection is a pure check over injectable paths so it is
//! unit-testable on any CI host; the install runs off the async reactor.

use std::path::Path;

use super::types::XServerError;

/// Canonical XQuartz install locations on macOS.
///
/// `/opt/X11` is the runtime/framework tree; the `.app` is the launcher. Either
/// present means XQuartz is installed.
const XQUARTZ_PATHS: [&str; 2] = ["/opt/X11", "/Applications/Utilities/XQuartz.app"];

/// The Homebrew invocation that installs XQuartz. `brew` prompts for admin auth
/// itself, so the install stays consent-based.
const BREW_INSTALL_ARGS: [&str; 3] = ["install", "--cask", "xquartz"];

/// Whether XQuartz is installed at the canonical macOS locations.
pub(super) fn xquartz_installed() -> bool {
    any_path_exists(&XQUARTZ_PATHS.map(Path::new))
}

/// Whether any of `paths` exists. Pure over injected paths so detection is
/// unit-testable against temp directories (mock FS).
fn any_path_exists<P: AsRef<Path>>(paths: &[P]) -> bool {
    paths.iter().any(|p| p.as_ref().exists())
}

/// Best-effort launch of XQuartz when it is installed but idle. Errors are
/// ignored — detection afterwards decides whether a server actually came up.
///
/// Only this fn is macOS-gated (`open -a` is nonsensical elsewhere and its caller
/// is `#[cfg(target_os = "macos")]`); the rest of the module stays ungated so the
/// cross-platform `dependency_available` / install-command match arms compile.
#[cfg(target_os = "macos")]
pub(super) fn launch_xquartz() {
    let _ = std::process::Command::new("open")
        .args(["-a", "XQuartz"])
        .spawn();
}

/// Guided, consent-based XQuartz install.
///
/// Only ever called from the `x_server_install_dependency` command — i.e. after
/// an explicit user action, never on the silent connect path. Uses Homebrew when
/// available (`brew install --cask xquartz`, which prompts for admin auth
/// itself); otherwise returns the actionable download guidance the UI surfaces as
/// an "Open xquartz.org" action. Never installs anything silently.
pub(crate) async fn install_xquartz() -> Result<(), XServerError> {
    if xquartz_installed() {
        return Ok(());
    }
    if !super::binary_on_path("brew") {
        // No automated path available (the hosted `.pkg` installer is a follow-up)
        // → hand back post-click download guidance rather than doing anything
        // silently. Distinct from the detect-path `xquartz_missing` (no brew
        // command, since brew is what's missing here).
        return Err(XServerError::xquartz_manual_install_required());
    }
    run_brew_install().await
}

/// Run `brew install --cask xquartz` off the async reactor, mapping a spawn
/// failure or non-zero exit to a typed, display-ready error.
async fn run_brew_install() -> Result<(), XServerError> {
    tokio::task::spawn_blocking(|| {
        let output = std::process::Command::new("brew")
            .args(BREW_INSTALL_ARGS)
            .output()
            .map_err(|e| XServerError::LaunchFailed {
                message: format!("Failed to run Homebrew: {e}"),
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
                message: format!("Homebrew failed to install XQuartz: {detail}"),
            })
        }
    })
    .await
    .map_err(|e| XServerError::LaunchFailed {
        message: format!("XQuartz install task failed: {e}"),
    })?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_when_a_canonical_path_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let present = tmp.path().join("opt-x11");
        std::fs::create_dir(&present).unwrap();
        let absent = tmp.path().join("nope");
        assert!(any_path_exists(&[present.as_path(), absent.as_path()]));
        assert!(any_path_exists(&[absent.as_path(), present.as_path()]));
    }

    #[test]
    fn not_detected_when_no_path_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("nope-a");
        let b = tmp.path().join("nope-b");
        assert!(!any_path_exists(&[a.as_path(), b.as_path()]));
    }

    #[test]
    fn xquartz_paths_are_the_documented_locations() {
        assert!(XQUARTZ_PATHS.contains(&"/opt/X11"));
        assert!(XQUARTZ_PATHS.contains(&"/Applications/Utilities/XQuartz.app"));
    }

    #[test]
    fn brew_install_args_target_the_xquartz_cask() {
        assert_eq!(BREW_INSTALL_ARGS, ["install", "--cask", "xquartz"]);
    }
}
