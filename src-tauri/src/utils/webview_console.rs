//! Linux-only WebKitGTK webview diagnostics for the full-app test bridge (#2646).
//!
//! On the headless ubuntu CI leg the app process, the WebKitGTK web-content
//! process, xdg-desktop-portal and GStreamer all come up cleanly, yet the page's
//! in-app bridge WebSocket client never dials within the wait budget — and the
//! only log the harness captures is the **Rust** side (`app.log` = the app's
//! merged stdout/stderr). A frontend JS error, a page-load failure, or a CSP
//! console violation lives in the **webview JS console**, which we do not
//! capture — so the failure is invisible and every attempt is log-starved.
//!
//! WebKit2GTK exposes no signal for JS `console.*` messages (that was WebKit1);
//! the supported way to surface them is the
//! `enable-write-console-messages-to-stdout` WebKitSettings flag, which prints
//! every console line — including CSP-violation reports — to the process stdout
//! the harness already tees into `app.log`. We also connect the `load-changed`
//! and `load-failed` signals so a failure to load the bundled `tauri://` /
//! `asset://` assets under WebKitGTK 2.52 is logged explicitly (Started →
//! Committed → Finished, or an error with the failing URI).
//!
//! Strictly diagnostic and strictly test-bridge-only: the caller gates this on
//! [`crate::utils::test_bridge::is_test_bridge_enabled`], and the whole module is
//! `#[cfg(target_os = "linux")]` so macOS/Windows never compile it. A production
//! launch reaches none of it.

use tauri::{Runtime, WebviewWindow};

/// Route the WebKitGTK webview's JS console output to process stdout and log its
/// page-load lifecycle, so a headless bridge-timeout run shows why the page's
/// bridge bootstrap never ran or connected.
///
/// Best-effort: any failure to reach the platform webview is logged and
/// swallowed — a diagnostic hook must never stop the app booting. This is a
/// no-op unless the caller has already confirmed test-bridge mode.
pub fn attach_console_capture<R: Runtime>(window: &WebviewWindow<R>) {
    // `with_webview` dispatches the closure onto the webview's GTK thread with
    // the platform handle. On Linux `PlatformWebview::inner()` yields the owned
    // `webkit2gtk::WebView` (the exact `wry`-pinned 2.0.2 build we depend on).
    let result = window.with_webview(|platform_webview| {
        use webkit2gtk::{SettingsExt, WebViewExt};

        let webview = platform_webview.inner();

        // Mirror JS console.log/warn/error — and any CSP-violation lines WebKit
        // emits — to stdout, which the system-test harness tees into `app.log`.
        // Fully-qualified `WebViewExt::settings` disambiguates from GtkWidget's
        // own `settings()`.
        match WebViewExt::settings(&webview) {
            Some(settings) => {
                settings.set_enable_write_console_messages_to_stdout(true);
                tracing::info!(
                    target: "webview-console",
                    "[webview-console] WebKitGTK console->stdout capture enabled (test bridge)"
                );
            }
            None => tracing::warn!(
                target: "webview-console",
                "[webview-console] no WebKitSettings on the webview; console capture unavailable"
            ),
        }

        // Log the page-load lifecycle so a stall or an asset-protocol failure
        // under WebKitGTK 2.52 is legible: Started → Committed → Finished, or an
        // explicit load-failed carrying the failing URI + error.
        webview.connect_load_changed(|_webview, event| {
            tracing::info!(
                target: "webview-console",
                ?event,
                "[webview-load-changed]"
            );
        });
        webview.connect_load_failed(|_webview, event, failing_uri, error| {
            tracing::error!(
                target: "webview-console",
                ?event,
                uri = failing_uri,
                error = %error,
                "[webview-load-failed] page/asset load failed"
            );
            // Return `false`: observe only, let WebKit run its own error handling.
            false
        });
    });

    if let Err(e) = result {
        tracing::warn!(
            target: "webview-console",
            "[webview-console] failed to attach diagnostics to the webview: {e}"
        );
    }
}
