//! macOS anti-throttling for the headless full-app E2E test bridge (#2480).
//!
//! The automated full-app system tests drive the real Tauri app (WKWebView)
//! headlessly via the Python bridge. When the app window is not the focused,
//! frontmost window, macOS applies two independent power-saving throttles that
//! break the harness:
//!
//! 1. **App Nap** suspends timers, lowers the app's scheduling priority and can
//!    coalesce/stall its runloop when the app looks idle and backgrounded.
//! 2. **WKWebView occlusion throttling** — once AppKit marks the window as
//!    occluded (or the app as not-frontmost), WebKit flips the page to the
//!    "hidden" visibility state and throttles JS timers, `requestAnimationFrame`
//!    and network activity. The frontend-driven agent-reconnect engine then
//!    never runs during the (idle) reconnect window and the test times out.
//!    This is the documented #957 / #2460 / #2480 wall.
//!
//! Two entry points, both **test-bridge-gated** by the caller
//! (`utils::test_bridge::is_test_bridge_enabled`) and `#[cfg(target_os = "macos")]`:
//!
//! * [`pre_launch_disable_occlusion_detection`] — call **before** the Tauri
//!   builder runs (before `NSApplication` launches). Sets the
//!   `NSWindowOcclusionDetectionEnabled` user default to `false`, which is the
//!   documented AppKit knob for occlusion detection and is read while the app
//!   launches. This is the reliable path; the private-selector attempt below is
//!   belt-and-suspenders.
//! * [`engage_test_bridge_unthrottle`] — call from the Tauri `setup()` hook
//!   (main thread). Holds an `NSProcessInfo` activity assertion for the process
//!   lifetime (defeats App Nap) and, as a backstop, tries the private
//!   `-[NSApplication _setWindowOcclusionDetectionEnabled:]` /
//!   `-[NSApplication setOcclusionDetectionEnabled:]` selector.
//!
//! With the env var unset or on a non-macOS target neither is invoked, so
//! production/default behaviour is byte-identical. This layers *alongside* the
//! existing always-on-top pin (#957) and the `TERMIHUB_TEST_NO_ALWAYS_ON_TOP`
//! opt-out (#2504) without touching either. A JS visibility-override injected by
//! the test-bridge init script (`utils::test_bridge`) is the third, frontend
//! layer that keeps the page's reconnect engine running even if WebKit still
//! believes the page is hidden.

/// The AppKit user-default key that controls window occlusion detection. Setting
/// it to `false` before launch stops AppKit from ever marking windows occluded,
/// so WebKit keeps the page visible and does not throttle its timers.
#[cfg(target_os = "macos")]
const OCCLUSION_DEFAULT_KEY: &str = "NSWindowOcclusionDetectionEnabled";

/// Set the `NSWindowOcclusionDetectionEnabled` user default to `false` in the
/// app's standard defaults, **before** the Tauri builder launches
/// `NSApplication`. Returns whether the write was issued.
///
/// This is the reliable occlusion-detection kill switch: AppKit reads this
/// default as the process launches, so it must run early (from `run()` before
/// `tauri::Builder`), not from `setup()` which is already past window creation.
/// Test-bridge-only; the caller gates on `is_test_bridge_enabled()`.
#[cfg(target_os = "macos")]
pub fn pre_launch_disable_occlusion_detection() -> bool {
    use objc2_foundation::{NSString, NSUserDefaults};

    let defaults = NSUserDefaults::standardUserDefaults();
    defaults.setBool_forKey(false, &NSString::from_str(OCCLUSION_DEFAULT_KEY));
    tracing::info!(
        key = OCCLUSION_DEFAULT_KEY,
        "test-bridge: set occlusion-detection user default to false (pre-launch, #2480)"
    );
    true
}

/// Engage the remaining macOS anti-throttling mechanisms for the test bridge.
///
/// Best-effort and safe to call once from the Tauri `setup()` hook (main
/// thread) after `NSApplication` exists. Holds an App-Nap-defeating activity
/// assertion and, as a backstop to [`pre_launch_disable_occlusion_detection`],
/// tries the private occlusion-detection selector. Any individual mechanism
/// failing is logged and skipped; it never blocks startup.
///
/// The caller must only invoke this when the test bridge is active
/// (`utils::test_bridge::is_test_bridge_enabled()`); this function does not
/// re-check the env so the gate stays in one place.
#[cfg(target_os = "macos")]
pub fn engage_test_bridge_unthrottle() {
    let app_nap_disabled = disable_app_nap();
    let occlusion_selector_applied = try_disable_occlusion_selector();

    tracing::info!(
        app_nap_disabled,
        occlusion_selector_applied,
        "test-bridge: anti-occlusion active (App Nap assertion held; occlusion default set pre-launch)"
    );
}

/// Hold an `NSProcessInfo` activity assertion for the process lifetime so macOS
/// App Nap never throttles the test app. Returns whether the assertion was
/// acquired.
#[cfg(target_os = "macos")]
fn disable_app_nap() -> bool {
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

    // `.userInitiated | .latencyCritical` keeps the app at an interactive
    // scheduling class; `.idleSystemSleepDisabled | .automaticTerminationDisabled`
    // keep it from being napped/terminated while it looks idle. This is the
    // documented App-Nap-defeating combination.
    let options = NSActivityOptions::UserInitiated
        | NSActivityOptions::LatencyCritical
        | NSActivityOptions::IdleSystemSleepDisabled
        | NSActivityOptions::AutomaticTerminationDisabled;

    let reason = NSString::from_str("termihub test bridge");
    let token = NSProcessInfo::processInfo().beginActivityWithOptions_reason(options, &reason);

    // The activity stays in effect only while the returned token is alive.
    // Intentionally leak it so the assertion is held for the whole process
    // lifetime (there is no point in the run where we want App Nap back).
    std::mem::forget(token);
    true
}

/// Backstop for the pre-launch user default: try the private AppKit selector
/// that disables window occlusion detection on the shared application. Tries the
/// underscore-prefixed private form first, then the historical non-prefixed
/// form; only sends the one `NSApp` actually responds to. Returns the name of
/// the selector that applied, or `None` if neither is available.
#[cfg(target_os = "macos")]
fn try_disable_occlusion_selector() -> Option<&'static str> {
    use objc2::{msg_send, sel, MainThreadMarker};
    use objc2_app_kit::NSApplication;

    let mtm = MainThreadMarker::new()?;
    let app = NSApplication::sharedApplication(mtm);

    // Try the underscore-prefixed private form first (the historical Chromium
    // trick), then the non-prefixed form. Each is guarded by
    // `respondsToSelector:`; the BOOL argument must be sent via a compile-time
    // `msg_send!` per selector (a runtime `Sel` cannot carry a typed argument).

    // SAFETY of every `msg_send!` below: `respondsToSelector:` returns a BOOL
    // and is safe to send to any object; the two occlusion selectors each take a
    // single `BOOL` and return void, and we only send the one `NSApp` confirmed
    // it responds to. Disabling occlusion detection is a process-wide AppKit
    // setting with no ownership/lifetime implications.
    let priv_sel = sel!(_setWindowOcclusionDetectionEnabled:);
    let responds_priv: bool = unsafe { msg_send![&*app, respondsToSelector: priv_sel] };
    if responds_priv {
        unsafe {
            let _: () = msg_send![&*app, _setWindowOcclusionDetectionEnabled: false];
        }
        return Some("_setWindowOcclusionDetectionEnabled:");
    }

    let pub_sel = sel!(setOcclusionDetectionEnabled:);
    let responds_pub: bool = unsafe { msg_send![&*app, respondsToSelector: pub_sel] };
    if responds_pub {
        unsafe {
            let _: () = msg_send![&*app, setOcclusionDetectionEnabled: false];
        }
        return Some("setOcclusionDetectionEnabled:");
    }

    tracing::warn!(
        "test-bridge: no NSApplication occlusion-detection selector available (relying on the pre-launch user default)"
    );
    None
}
