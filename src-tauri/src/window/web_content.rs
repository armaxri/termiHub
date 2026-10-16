//! Recover a macOS window whose WebKit web content process died (#4861).
//!
//! Each WKWebView renders in a separate WebContent process. macOS can end that
//! process on its own: it crashed, or the system reclaimed it under memory
//! pressure. WebKit then calls `webViewWebContentProcessDidTerminate:`, and the
//! window stays blank until the app reloads it. wry does nothing in that
//! callback unless a handler is registered, so before this module the window
//! went blank for good. Its page was gone, so it ran no more code, and its
//! test-bridge socket closed without reconnecting.
//!
//! [`on_web_content_process_terminate`] logs the event, so the durable log
//! shows which window lost its page, and reloads the webview. The page then
//! boots again and rebuilds its state from the backend, which still owns every
//! session.

use tauri::{Runtime, Webview};

/// Handler for `tauri::Builder::on_web_content_process_terminate`: log the
/// termination and reload `webview` so the window shows its page again.
pub fn on_web_content_process_terminate<R: Runtime>(webview: &Webview<R>) {
    let window = webview.label();
    tracing::warn!(
        window,
        "Web content process terminated; reloading the window's page (#4861)"
    );
    if let Err(err) = webview.reload() {
        tracing::error!(
            window,
            error = %err,
            "Could not reload the window after its web content process terminated"
        );
    }
}
