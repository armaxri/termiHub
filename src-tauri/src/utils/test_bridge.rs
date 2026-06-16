//! Test-mode wiring for the cross-platform WebSocket test bridge (issue #801).
//!
//! When the app is launched with `TERMIHUB_TEST_BRIDGE_PORT` set to a valid TCP
//! port, this module builds a Tauri plugin that injects two globals into the
//! webview *before* any page script runs. The in-app bridge reads them
//! (`src/testbridge/testMode.ts`) to enable test mode and connect its WebSocket
//! client out to the runner's server on that port.
//!
//! A plugin-level `js_init_script` is used rather than a `WebviewWindowBuilder`
//! init script because the main window is created from `tauri.conf.json`; the
//! plugin's script applies to that config-created webview and runs before the
//! HTML document is parsed.
//!
//! The plugin is only registered when the env var is present, so production
//! builds inject nothing and the bridge stays inert.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Env var holding the runner's WebSocket port the app should connect out to.
pub const TEST_BRIDGE_PORT_ENV: &str = "TERMIHUB_TEST_BRIDGE_PORT";

/// JavaScript that opts the in-app bridge into WebSocket test mode.
///
/// Mirrors the keys read by `src/testbridge/testMode.ts`
/// (`TEST_BRIDGE_GLOBAL_KEY` and `TEST_BRIDGE_PORT_GLOBAL_KEY`). Assigns to
/// `window` explicitly since the script runs in its own function scope.
fn test_bridge_init_script(port: u16) -> String {
    format!(
        "window.__TERMIHUB_TEST_BRIDGE__ = true; window.__TERMIHUB_TEST_BRIDGE_PORT__ = {port};"
    )
}

/// Parse the bridge port from the env var, rejecting absent/blank/invalid/zero.
fn parse_port(raw: Option<String>) -> Option<u16> {
    raw?.trim().parse::<u16>().ok().filter(|&port| port != 0)
}

/// Build the test-bridge plugin when `TERMIHUB_TEST_BRIDGE_PORT` names a valid
/// port, or `None` in normal use so the caller registers nothing.
pub fn test_bridge_plugin<R: Runtime>() -> Option<TauriPlugin<R>> {
    let port = parse_port(std::env::var(TEST_BRIDGE_PORT_ENV).ok())?;
    Some(
        Builder::new("termihub-test-bridge")
            .js_init_script(test_bridge_init_script(port))
            .build(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_script_sets_both_globals() {
        let script = test_bridge_init_script(48123);
        assert!(script.contains("window.__TERMIHUB_TEST_BRIDGE__ = true"));
        assert!(script.contains("window.__TERMIHUB_TEST_BRIDGE_PORT__ = 48123"));
    }

    #[test]
    fn parses_a_valid_port() {
        assert_eq!(parse_port(Some("48123".to_string())), Some(48123));
        assert_eq!(parse_port(Some("  9090 ".to_string())), Some(9090));
    }

    #[test]
    fn rejects_absent_blank_zero_and_out_of_range() {
        assert_eq!(parse_port(None), None);
        assert_eq!(parse_port(Some("".to_string())), None);
        assert_eq!(parse_port(Some("0".to_string())), None);
        assert_eq!(parse_port(Some("70000".to_string())), None);
        assert_eq!(parse_port(Some("not-a-port".to_string())), None);
    }
}
