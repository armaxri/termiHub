//! macOS XQuartz detection and guided, consent-based install (#1054).
//!
//! macOS can't embed an X server, so termiHub detects XQuartz and — only on an
//! explicit user action, never silently — guides its install. Detection is a
//! pure check over injectable paths so it is unit-testable on any CI host.

use std::path::Path;

/// Canonical XQuartz install locations on macOS.
///
/// `/opt/X11` is the runtime/framework tree; the `.app` is the launcher. Either
/// present means XQuartz is installed.
const XQUARTZ_PATHS: [&str; 2] = ["/opt/X11", "/Applications/Utilities/XQuartz.app"];

/// Whether XQuartz is installed at the canonical macOS locations.
pub(super) fn xquartz_installed() -> bool {
    any_path_exists(&XQUARTZ_PATHS.map(Path::new))
}

/// Whether any of `paths` exists. Pure over injected paths so detection is
/// unit-testable against temp directories (mock FS).
fn any_path_exists<P: AsRef<Path>>(_paths: &[P]) -> bool {
    // Stubbed until the detection is implemented (see #1054).
    false
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
}
