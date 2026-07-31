//! A Tauri custom URI-scheme protocol that serves files out of installed
//! plugins' directories from an **app-controlled origin** — the substrate for
//! moving frontend-plugin execution off `blob:` (#2251, part of #2136).
//!
//! # Why this exists
//!
//! Frontend plugin JS runs inside a least-privilege Web Worker (#2136). Today the
//! worker executes each plugin by turning its source into a `blob:` URL and
//! `importScripts`-ing that — which only works because `script-src` still allows
//! `blob:`. To drop `blob:` from `script-src`, plugin code has to load from a URL
//! whose origin already satisfies `script-src`. This protocol provides exactly
//! that origin: `plugin://localhost/<id>/<relative-path>` (macOS/iOS/Linux) /
//! `http://plugin.localhost/<id>/<relative-path>` (Windows/Android) reads
//! `<app-data>/plugins/<id>/<relative-path>` and returns its bytes.
//!
//! This module is the **substrate only**: registering the scheme and serving the
//! bytes safely. Switching the sandbox worker's loader onto it, adding the origin
//! to `script-src`, and finally removing `blob:` are the follow-up slice — until
//! then this origin is not listed in the CSP, so the webview cannot yet reach it
//! (the handler is nonetheless fully exercised by the unit tests below).
//!
//! # Path safety
//!
//! Every read is delegated to [`PluginManager::read_file`], which re-validates the
//! plugin id against the manifest slug rule and refuses any `..`/absolute
//! traversal in the relative path (`core/src/plugin/manager.rs`). This module adds
//! percent-decoding and request-shape validation on top, and fails **closed**: any
//! malformed request or read error becomes an empty `403`/`404`, never a partial
//! or misattributed body.

use std::borrow::Cow;

use percent_encoding::percent_decode_str;
use tauri::http::{header::CONTENT_TYPE, Request, Response, StatusCode};
use tauri::{Manager, Runtime, UriSchemeContext};
use termihub_core::plugin::{PluginManager, PluginManagerError};

/// The custom URI scheme this protocol registers. The webview origin it produces
/// differs per platform (see the module docs), which the CSP follow-up must
/// account for when it adds the origin to `script-src`.
pub const PLUGIN_URI_SCHEME: &str = "plugin";

/// Split a request path (`/<id>/<relative...>`) into the plugin id and the
/// relative path within that plugin's directory.
///
/// Returns `None` when there is no id segment or no relative path (a bare
/// `plugin://localhost/` or `plugin://localhost/<id>` has nothing to serve). Both
/// pieces are percent-decoded; a byte sequence that is not valid UTF-8 after
/// decoding is rejected. Traversal is *not* checked here — that is
/// [`PluginManager::read_file`]'s job, so there is a single source of truth for
/// containment.
fn parse_request_path(path: &str) -> Option<(String, String)> {
    let trimmed = path.trim_start_matches('/');
    let (id_enc, rest_enc) = trimmed.split_once('/')?;
    if id_enc.is_empty() || rest_enc.is_empty() {
        return None;
    }
    let id = percent_decode_str(id_enc).decode_utf8().ok()?.into_owned();
    let relative = percent_decode_str(rest_enc)
        .decode_utf8()
        .ok()?
        .into_owned();
    if id.is_empty() || relative.is_empty() {
        return None;
    }
    Some((id, relative))
}

/// Best-effort `Content-Type` for a served asset, by file extension. Plugin
/// entry points are JavaScript; themes are JSON. Anything else is served as
/// opaque bytes so the caller must know what it asked for.
fn content_type_for(relative: &str) -> &'static str {
    let ext = std::path::Path::new(relative)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    match ext.as_deref() {
        // `text/javascript` is the WHATWG-recommended type and the one
        // `importScripts`/module loading accept across WKWebView, WebView2 and
        // webkit2gtk.
        Some("js" | "mjs" | "cjs") => "text/javascript",
        Some("json") => "application/json",
        Some("css") => "text/css",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// Map a plugin file read into an HTTP status for the failure case. A missing
/// plugin/file is `404`; a traversal or invalid id is `403`; anything else
/// (I/O, store corruption) is `500`. No error body is returned — the webview
/// never needs the detail, and leaking paths would be an information disclosure.
fn status_for_error(err: &PluginManagerError) -> StatusCode {
    match err {
        PluginManagerError::NotFound(_) => StatusCode::NOT_FOUND,
        PluginManagerError::PathTraversal(_) | PluginManagerError::UnsafePath(_) => {
            StatusCode::FORBIDDEN
        }
        PluginManagerError::Io(e) if e.kind() == std::io::ErrorKind::NotFound => {
            StatusCode::NOT_FOUND
        }
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

/// Build a fixed-status empty response — the fail-closed path for every rejected
/// or failed request.
fn empty(status: StatusCode) -> Response<Cow<'static, [u8]>> {
    // `Response::builder().body(..)` only errors on an invalid status/header,
    // and every status we pass is a constant, so this cannot fail in practice.
    Response::builder()
        .status(status)
        .body(Cow::Borrowed(&[][..]))
        .expect("static empty response is always valid")
}

/// Serve one request for the plugin scheme: resolve `<id>/<relative>` from the
/// URI path and return the file bytes from `<app-data>/plugins/<id>/`, or an
/// empty error response. This is the testable core of the protocol, independent
/// of Tauri's request/response plumbing.
pub fn serve(manager: &PluginManager, uri_path: &str) -> Response<Cow<'static, [u8]>> {
    let Some((id, relative)) = parse_request_path(uri_path) else {
        return empty(StatusCode::BAD_REQUEST);
    };

    match manager.read_file(&id, &relative) {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, content_type_for(&relative))
            .body(Cow::Owned(bytes))
            .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR)),
        Err(err) => empty(status_for_error(&err)),
    }
}

/// The URI-scheme protocol handler registered on the Tauri builder. Extracts the
/// request path and the managed [`PluginManager`], then delegates to [`serve`].
/// If the manager is not (yet) managed the request fails closed with `503`.
pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Cow<'static, [u8]>> {
    let path = request.uri().path().to_owned();
    match ctx.app_handle().try_state::<PluginManager>() {
        Some(manager) => serve(&manager, &path),
        None => empty(StatusCode::SERVICE_UNAVAILABLE),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;
    use termihub_core::plugin::PluginManager;

    /// Build a `PluginManager` over a temp plugins root containing one installed
    /// plugin `demo` with a manifest and a `frontend/index.js` entry point.
    fn manager_with_demo_plugin() -> (TempDir, PluginManager) {
        let tmp = TempDir::new().expect("temp dir");
        let root = tmp.path().join("plugins");
        let dir = root.join("demo");
        fs::create_dir_all(dir.join("frontend")).expect("create plugin dir");
        // A minimal valid manifest so the plugin directory is recognised.
        fs::write(
            dir.join("manifest.json"),
            r#"{
                "id": "demo",
                "name": "Demo",
                "version": "1.0.0",
                "apiVersion": "1.0",
                "description": "test",
                "author": "test"
            }"#,
        )
        .expect("write manifest");
        fs::write(
            dir.join("frontend/index.js"),
            b"self.termihub = self.termihub;",
        )
        .expect("write entry");
        (tmp, PluginManager::new(root))
    }

    fn body_bytes<'a>(resp: &'a Response<Cow<'static, [u8]>>) -> &'a [u8] {
        resp.body().as_ref()
    }

    #[test]
    fn parse_splits_id_and_relative() {
        assert_eq!(
            parse_request_path("/demo/frontend/index.js"),
            Some(("demo".into(), "frontend/index.js".into()))
        );
    }

    #[test]
    fn parse_percent_decodes_segments() {
        // A space encoded in the path decodes back to the real filename.
        assert_eq!(
            parse_request_path("/demo/frontend/my%20file.js"),
            Some(("demo".into(), "frontend/my file.js".into()))
        );
    }

    #[test]
    fn parse_rejects_missing_relative_or_id() {
        assert_eq!(parse_request_path("/"), None);
        assert_eq!(parse_request_path("/demo"), None);
        assert_eq!(parse_request_path("/demo/"), None);
        assert_eq!(parse_request_path("//index.js"), None);
    }

    #[test]
    fn content_type_maps_known_extensions() {
        assert_eq!(content_type_for("frontend/index.js"), "text/javascript");
        assert_eq!(content_type_for("theme.JSON"), "application/json");
        assert_eq!(content_type_for("data.bin"), "application/octet-stream");
        assert_eq!(content_type_for("noext"), "application/octet-stream");
    }

    #[test]
    fn serve_returns_entry_bytes_with_js_content_type() {
        let (_tmp, manager) = manager_with_demo_plugin();
        let resp = serve(&manager, "/demo/frontend/index.js");
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(resp.headers().get(CONTENT_TYPE).unwrap(), "text/javascript");
        assert_eq!(body_bytes(&resp), b"self.termihub = self.termihub;");
    }

    #[test]
    fn serve_rejects_traversal_with_forbidden() {
        let (_tmp, manager) = manager_with_demo_plugin();
        // A decoded `..` escape is refused by `read_file` and surfaced as 403.
        let resp = serve(&manager, "/demo/..%2f..%2fsecret.txt");
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        assert!(body_bytes(&resp).is_empty());
    }

    #[test]
    fn serve_rejects_traversing_id_with_forbidden() {
        let (_tmp, manager) = manager_with_demo_plugin();
        let resp = serve(&manager, "/..%2f..%2fetc/passwd");
        // A `..` plugin id is not a valid slug → PathTraversal → 403.
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn serve_missing_file_is_not_found() {
        let (_tmp, manager) = manager_with_demo_plugin();
        let resp = serve(&manager, "/demo/frontend/does-not-exist.js");
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn serve_unknown_plugin_is_not_found() {
        let (_tmp, manager) = manager_with_demo_plugin();
        let resp = serve(&manager, "/ghost/frontend/index.js");
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn serve_malformed_request_is_bad_request() {
        let (_tmp, manager) = manager_with_demo_plugin();
        assert_eq!(serve(&manager, "/demo").status(), StatusCode::BAD_REQUEST);
        assert_eq!(serve(&manager, "/").status(), StatusCode::BAD_REQUEST);
    }
}
