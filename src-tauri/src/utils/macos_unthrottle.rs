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
//! [`engage_test_bridge_unthrottle`] layers the macOS mechanisms that keep the
//! app + its WKWebView fully awake while unfocused/occluded:
//!
//! * an `NSProcessInfo` **activity assertion** (`beginActivityWithOptions:reason:`)
//!   held for the process lifetime, which defeats App Nap; and
//! * disabling AppKit's **window occlusion detection**
//!   (`-[NSApplication _setWindowOcclusionDetectionEnabled:]`), so WebKit never
//!   marks the page hidden and never throttles its timers.
//!
//! Everything here is **test-bridge-gated** by the caller
//! (`utils::test_bridge::is_test_bridge_enabled`) and `#[cfg(target_os = "macos")]`.
//! With the env var unset or on a non-macOS target this module is never invoked,
//! so production/default behaviour is byte-identical. It layers *alongside* the
//! existing always-on-top pin (#957) and the `TERMIHUB_TEST_NO_ALWAYS_ON_TOP`
//! opt-out (#2504) without touching either.

/// `-[NSApplication _setWindowOcclusionDetectionEnabled:]` — a private AppKit
/// selector (used by Chromium/Electron for exactly this purpose) that turns off
/// window occlusion tracking process-wide. With occlusion detection off, AppKit
/// never reports the window as occluded, so WebKit keeps the page in the
/// "visible" state and does not throttle its timers/rAF/network. Guarded by a
/// `respondsToSelector:` check so a future macOS that drops it degrades to a
/// no-op instead of crashing.
#[cfg(target_os = "macos")]
const OCCLUSION_DETECTION_SELECTOR: &str = "_setWindowOcclusionDetectionEnabled:";

/// Engage the macOS anti-throttling mechanisms for the test bridge.
///
/// Best-effort and idempotent-safe to call once from the Tauri `setup()` hook
/// (main thread) after `NSApplication` exists. Any individual mechanism failing
/// is logged and skipped; it never blocks startup.
///
/// The caller must only invoke this when the test bridge is active
/// (`utils::test_bridge::is_test_bridge_enabled()`); this function does not
/// re-check the env so the gate stays in one place.
#[cfg(target_os = "macos")]
pub fn engage_test_bridge_unthrottle() {
    let app_nap_disabled = disable_app_nap();
    let occlusion_disabled = disable_window_occlusion_detection();

    tracing::info!(
        app_nap_disabled,
        occlusion_disabled,
        "test-bridge: anti-occlusion active (App Nap disabled, occlusion detection off)"
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

/// Turn off AppKit window occlusion detection so WebKit never throttles the
/// page's timers when the window is unfocused/occluded. Returns whether the
/// selector was available and invoked.
#[cfg(target_os = "macos")]
fn disable_window_occlusion_detection() -> bool {
    use objc2::{msg_send, sel, MainThreadMarker};
    use objc2_app_kit::NSApplication;

    let Some(mtm) = MainThreadMarker::new() else {
        tracing::warn!(
            "test-bridge: skipping occlusion-detection disable (not on the main thread)"
        );
        return false;
    };

    let app = NSApplication::sharedApplication(mtm);
    // Resolved at compile time; matches OCCLUSION_DETECTION_SELECTOR (kept for
    // the log line below).
    let sel = sel!(_setWindowOcclusionDetectionEnabled:);

    // SAFETY: `respondsToSelector:` takes a selector and returns a BOOL; it is
    // safe to send to any object. We only send the private
    // `_setWindowOcclusionDetectionEnabled:` selector after confirming the
    // running AppKit implements it, and it takes a single BOOL argument.
    let responds: bool = unsafe { msg_send![&*app, respondsToSelector: sel] };
    if !responds {
        tracing::warn!(
            selector = OCCLUSION_DETECTION_SELECTOR,
            "test-bridge: AppKit does not implement occlusion-detection selector; skipping"
        );
        return false;
    }

    // SAFETY: confirmed above that NSApp responds to this selector; it takes a
    // single `BOOL` and returns void. Disabling occlusion detection is a
    // process-wide AppKit setting with no ownership/lifetime implications.
    unsafe {
        let _: () = msg_send![&*app, _setWindowOcclusionDetectionEnabled: false];
    }
    true
}
