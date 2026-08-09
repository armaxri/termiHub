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

/// Env var to opt out of pinning the test window always-on-top under the test
/// bridge (#2504). When set to a truthy value (`1`/`true`, any case), the
/// anti-occlusion pin (#957) is skipped so an operator can background the
/// window during a guided-manual grade (read the checklist, use a second
/// terminal). Unset → behaviour is unchanged (the window is still pinned).
pub const TEST_NO_ALWAYS_ON_TOP_ENV: &str = "TERMIHUB_TEST_NO_ALWAYS_ON_TOP";

/// Env-var prefix for injecting a runtime feature-flag global into the webview
/// under the test bridge (#2476). `TERMIHUB_TEST_FLAG_<NAME>=<bool>` injects
/// `window.__TERMIHUB_<NAME>__ = <bool>` before boot, so the harness can flip a
/// `window.__TERMIHUB_*__`-gated flag for a live run (e.g. the agent reconnect
/// activation reads `__TERMIHUB_SESSION_BACKEND_REATTACH__`) without a bridge
/// protocol round-trip. Only active in test-bridge mode; production injects none.
pub const TEST_FLAG_ENV_PREFIX: &str = "TERMIHUB_TEST_FLAG_";

/// Whether a `TERMIHUB_TEST_FLAG_*` value reads as truthy (`1`/`true`, any case).
fn flag_is_truthy(raw: &str) -> bool {
    matches!(raw.trim().to_ascii_lowercase().as_str(), "1" | "true")
}

/// Whether an env-var suffix is a safe JS identifier fragment (`[A-Za-z0-9_]+`),
/// so the injected `window.__TERMIHUB_<NAME>__` can never be a script-injection
/// vector. Env-var names are already restricted to this set, so this is a
/// belt-and-suspenders guard.
fn is_safe_flag_name(name: &str) -> bool {
    !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// JavaScript that sets each `TERMIHUB_TEST_FLAG_<NAME>` env var as the boolean
/// global `window.__TERMIHUB_<NAME>__`. Empty when none are set. Names are sorted
/// so the emitted script is deterministic (stable across runs / for tests).
fn feature_flag_init_script() -> String {
    let mut pairs: Vec<(String, bool)> = std::env::vars()
        .filter_map(|(key, val)| {
            let name = key.strip_prefix(TEST_FLAG_ENV_PREFIX)?;
            is_safe_flag_name(name).then(|| (name.to_string(), flag_is_truthy(&val)))
        })
        .collect();
    pairs.sort();
    pairs
        .into_iter()
        .map(|(name, value)| format!(" window.__TERMIHUB_{name}__ = {value};"))
        .collect()
}

/// JavaScript that opts the in-app bridge into WebSocket test mode.
///
/// Mirrors the keys read by `src/testbridge/testMode.ts`
/// (`TEST_BRIDGE_GLOBAL_KEY` and `TEST_BRIDGE_PORT_GLOBAL_KEY`). Assigns to
/// `window` explicitly since the script runs in its own function scope. Any
/// `TERMIHUB_TEST_FLAG_*` feature-flag globals are appended (#2476).
fn test_bridge_init_script(port: u16) -> String {
    format!(
        "window.__TERMIHUB_TEST_BRIDGE__ = true; window.__TERMIHUB_TEST_BRIDGE_PORT__ = {port};{}",
        feature_flag_init_script()
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

/// Whether the app was launched in WebSocket test-bridge mode
/// (`TERMIHUB_TEST_BRIDGE_PORT` names a valid port).
///
/// Used to apply harness-only window behaviour — e.g. keeping the window
/// always-on-top so macOS never fully occludes the webview and throttles its
/// rendering (see #957). Production launches return `false`.
pub fn is_test_bridge_enabled() -> bool {
    parse_port(std::env::var(TEST_BRIDGE_PORT_ENV).ok()).is_some()
}

/// Whether the operator has opted out of pinning the test window always-on-top
/// (`TERMIHUB_TEST_NO_ALWAYS_ON_TOP` set to a truthy value). See #2504. Used only
/// in test-bridge mode; production launches never pin the window regardless.
pub fn always_on_top_opt_out() -> bool {
    std::env::var(TEST_NO_ALWAYS_ON_TOP_ENV)
        .ok()
        .is_some_and(|raw| flag_is_truthy(&raw))
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
    fn flag_truthiness_matches_common_forms() {
        assert!(flag_is_truthy("1"));
        assert!(flag_is_truthy("true"));
        assert!(flag_is_truthy(" TRUE "));
        assert!(!flag_is_truthy("0"));
        assert!(!flag_is_truthy("false"));
        assert!(!flag_is_truthy(""));
    }

    #[test]
    fn safe_flag_name_rejects_injection() {
        assert!(is_safe_flag_name("SESSION_BACKEND_REATTACH"));
        assert!(is_safe_flag_name("A1_B2"));
        assert!(!is_safe_flag_name(""));
        assert!(!is_safe_flag_name("A;window.x=1"));
        assert!(!is_safe_flag_name("A-B"));
    }

    #[test]
    fn feature_flag_script_injects_env_flags_sorted_and_typed() {
        // Mutates process-global env vars under unique keys no other test reads.
        let on = "TERMIHUB_TEST_FLAG_ZZZ_ON";
        let off = "TERMIHUB_TEST_FLAG_AAA_OFF";
        unsafe {
            std::env::set_var(on, "1");
            std::env::set_var(off, "false");
        }
        let script = feature_flag_init_script();
        assert_eq!(
            script,
            " window.__TERMIHUB_AAA_OFF__ = false; window.__TERMIHUB_ZZZ_ON__ = true;"
        );
        unsafe {
            std::env::remove_var(on);
            std::env::remove_var(off);
        }
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

    #[test]
    fn always_on_top_opt_out_tracks_truthy_env_var() {
        // Mutates a process-global env var; no other test reads this key.
        let key = TEST_NO_ALWAYS_ON_TOP_ENV;
        let saved = std::env::var(key).ok();
        unsafe { std::env::remove_var(key) };
        assert!(
            !always_on_top_opt_out(),
            "unset → do not opt out (pin stays)"
        );
        unsafe { std::env::set_var(key, "1") };
        assert!(always_on_top_opt_out());
        unsafe { std::env::set_var(key, "true") };
        assert!(always_on_top_opt_out());
        unsafe { std::env::set_var(key, "0") };
        assert!(!always_on_top_opt_out());
        unsafe { std::env::set_var(key, "") };
        assert!(!always_on_top_opt_out());
        match saved {
            Some(v) => unsafe { std::env::set_var(key, v) },
            None => unsafe { std::env::remove_var(key) },
        }
    }

    #[test]
    fn is_test_bridge_enabled_tracks_the_env_var() {
        // Mutates a process-global env var; no other test reads this key.
        let key = TEST_BRIDGE_PORT_ENV;
        let saved = std::env::var(key).ok();
        unsafe { std::env::set_var(key, "48123") };
        assert!(is_test_bridge_enabled());
        unsafe { std::env::set_var(key, "0") };
        assert!(!is_test_bridge_enabled());
        unsafe { std::env::remove_var(key) };
        assert!(!is_test_bridge_enabled());
        match saved {
            Some(v) => unsafe { std::env::set_var(key, v) },
            None => unsafe { std::env::remove_var(key) },
        }
    }
}
