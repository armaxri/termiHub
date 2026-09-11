use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::body::Body;
use axum::extract::State;
use axum::handler::Handler;
use axum::http::{Request, StatusCode};
use axum::middleware::Next;
use axum::response::{Html, IntoResponse, Response};
use axum::{middleware, Router};
use tower_http::services::ServeDir;

use super::config::{AtomicServerStats, EmbeddedServerConfig};
use super::service::BindSignal;
use super::shutdown::ShutdownSignal;

/// State shared with middleware for connection tracking.
#[derive(Clone)]
struct TrackingState {
    stats: Arc<AtomicServerStats>,
}

/// Tower middleware that tracks active and total HTTP connections.
async fn track_connections(
    State(state): State<TrackingState>,
    req: Request<Body>,
    next: Next,
) -> Response {
    state
        .stats
        .active_connections
        .fetch_add(1, Ordering::Relaxed);
    state
        .stats
        .total_connections
        .fetch_add(1, Ordering::Relaxed);

    let resp = next.run(req).await;

    // Approximate bytes sent via Content-Length header.
    if let Some(cl) = resp
        .headers()
        .get(axum::http::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
    {
        state.stats.bytes_sent.fetch_add(cl, Ordering::Relaxed);
    }

    state
        .stats
        .active_connections
        .fetch_sub(1, Ordering::Relaxed);

    resp
}

/// Escape a string for safe interpolation into HTML text and double-quoted
/// attribute contexts.
///
/// Entity-encodes the five HTML-significant characters (`& < > " '`) so an
/// attacker-controlled filename or reflected request path — e.g. a file literally
/// named `"><img src=x onerror=alert(1)>`, a legal name on Unix — cannot break out
/// of the `href` attribute or the surrounding markup and inject script
/// (SEC-007 / CORE-025). `&` is replaced first (it is the escape introducer) so
/// already-escaped output is never double-mangled beyond the intended entities.
fn html_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#x27;"),
            _ => out.push(c),
        }
    }
    out
}

/// Render a single directory-listing `<li>` entry for a filesystem name.
///
/// The name is HTML-escaped before it is interpolated into both the `href`
/// attribute and the anchor text, so a hostile filename (e.g. one literally
/// named `<img src=x onerror=alert(1)>`, a legal name on Unix) cannot inject
/// HTML into the generated listing (SEC-007 / CORE-025). Directories get a
/// trailing `/`. Kept as a pure `&str` -> `String` function so the escaping
/// can be exercised in tests without creating real (and, on Windows, illegal)
/// files on disk.
fn render_listing_entry(name: &str, is_dir: bool) -> String {
    let suffix = if is_dir { "/" } else { "" };
    let name = html_escape(name);
    format!(r#"<li><a href="{name}{suffix}">{name}{suffix}</a></li>"#)
}

/// Build a simple HTML directory listing page for the given path.
fn directory_listing_html(
    dir_path: &std::path::Path,
    url_path: &str,
) -> Result<String, std::io::Error> {
    let entries = std::fs::read_dir(dir_path)?;
    let mut items = Vec::new();

    // Parent link (not for root).
    if url_path != "/" {
        items.push(r#"<li><a href="../">../</a></li>"#.to_string());
    }

    let mut names: Vec<(bool, String)> = entries
        .filter_map(|e| e.ok())
        .map(|e| {
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            let name = e.file_name().to_string_lossy().into_owned();
            (is_dir, name)
        })
        .collect();

    // Directories first, then files, both sorted alphabetically.
    names.sort_by(|a, b| match (a.0, b.0) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.1.cmp(&b.1),
    });

    for (is_dir, name) in names {
        items.push(render_listing_entry(&name, is_dir));
    }

    let listing = items.join("\n        ");
    // Escape the reflected request path before interpolating it into the
    // `<title>`/`<h1>` so a crafted URL cannot reflect script into the page.
    let url_path = html_escape(url_path);
    Ok(format!(
        r#"<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Index of {url_path}</title></head>
<body>
<h1>Index of {url_path}</h1>
<ul>
        {listing}
</ul>
</body>
</html>"#
    ))
}

/// Handler invoked for paths that `ServeDir` could not serve as a file.
///
/// For real directories it renders an HTML index; for anything else it returns
/// `404`. File requests never reach this handler — `ServeDir` serves them
/// directly (see [`build_router`]).
async fn dir_listing_handler(
    axum::extract::State(root): axum::extract::State<PathBuf>,
    axum::extract::OriginalUri(uri): axum::extract::OriginalUri,
) -> Response {
    let url_path = uri.path();
    // Resolve the filesystem path, rejecting traversal outside root.
    let rel = url_path.trim_start_matches('/');
    let full_path = root.join(rel);
    let full_path = match full_path.canonicalize() {
        Ok(p) => p,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    let root_canon = match root.canonicalize() {
        Ok(p) => p,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    // Security: reject paths that escape the root.
    if !full_path.starts_with(&root_canon) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !full_path.is_dir() {
        // Not a directory (e.g. a genuinely missing path) — 404.
        return StatusCode::NOT_FOUND.into_response();
    }
    match directory_listing_html(&full_path, url_path) {
        Ok(html) => Html(html).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// Build the HTTP router serving files from `root`.
///
/// When `directory_listing` is enabled, files are served by [`ServeDir`] and any
/// path it cannot serve as a file (directories, missing paths) falls through to
/// [`dir_listing_handler`], which renders a directory index for real
/// directories. Index-file auto-serving is disabled so directories always render
/// the generated listing. When disabled, only [`ServeDir`] is used.
fn build_router(root: PathBuf, directory_listing: bool, tracking_state: TrackingState) -> Router {
    let router = if directory_listing {
        let serve_dir = ServeDir::new(root.clone())
            .append_index_html_on_directories(false)
            .fallback(dir_listing_handler.with_state(root));
        Router::new().fallback_service(serve_dir)
    } else {
        Router::new().fallback_service(ServeDir::new(root))
    };

    router.layer(middleware::from_fn_with_state(
        tracking_state,
        track_connections,
    ))
}

/// Start and run the HTTP server, blocking until the shutdown signal fires.
///
/// The function must be called from within a dedicated std thread that builds
/// its own tokio runtime. `ready` is signalled exactly once as soon as the
/// listening socket is bound (or if binding fails), so the manager only reports
/// `Running` after the bind is confirmed (GAP G3, #1145).
pub fn start_http_server(
    config: &EmbeddedServerConfig,
    shutdown: ShutdownSignal,
    stats: Arc<AtomicServerStats>,
    ready: BindSignal,
) -> Result<()> {
    let addr: SocketAddr = match format!("{}:{}", config.bind_host, config.port)
        .parse()
        .context("Invalid bind address")
    {
        Ok(addr) => addr,
        Err(e) => {
            ready.fail(&e.to_string());
            return Err(e);
        }
    };

    let root = PathBuf::from(&config.root_directory);
    let directory_listing = config.directory_listing.unwrap_or(false);
    let tracking_state = TrackingState {
        stats: stats.clone(),
    };

    // Build a tokio current-thread runtime in this thread.
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("Failed to build async runtime")
    {
        Ok(rt) => rt,
        Err(e) => {
            ready.fail(&e.to_string());
            return Err(e);
        }
    };

    rt.block_on(async move {
        let listener = match tokio::net::TcpListener::bind(addr)
            .await
            .context("Failed to bind HTTP server")
        {
            Ok(listener) => listener,
            Err(e) => {
                ready.fail(&e.to_string());
                return Err(e);
            }
        };

        // Bind confirmed — tell the manager it is safe to report Running.
        ready.confirm();

        let router = build_router(root, directory_listing, tracking_state);

        tracing::info!(addr = %addr, "HTTP server listening");

        axum::serve(listener, router)
            // Event-driven shutdown: park until the signal fires, then stop
            // immediately — no busy-poll and no fixed latency (WA-RS-001).
            .with_graceful_shutdown(async move {
                shutdown.wait().await;
            })
            .await
            .context("HTTP server error")?;

        Ok::<(), anyhow::Error>(())
    })?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    /// Build a router over a temp dir containing a single `hello.txt` file.
    fn router_with_hello(directory_listing: bool) -> (tempfile::TempDir, Router) {
        let dir = tempfile::tempdir().expect("create temp dir");
        std::fs::write(dir.path().join("hello.txt"), "hello world").expect("write file");
        let tracking_state = TrackingState {
            stats: AtomicServerStats::new(),
        };
        let router = build_router(dir.path().to_path_buf(), directory_listing, tracking_state);
        (dir, router)
    }

    async fn get(router: Router, uri: &str) -> (StatusCode, String) {
        let response = router
            .oneshot(
                Request::builder()
                    .uri(uri)
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("read body");
        (status, String::from_utf8_lossy(&bytes).into_owned())
    }

    /// Regression test for #961: with directory listing enabled, downloading an
    /// individual file must still succeed (previously returned 404).
    #[tokio::test]
    async fn listing_on_serves_file() {
        let (_dir, router) = router_with_hello(true);
        let (status, body) = get(router, "/hello.txt").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, "hello world");
    }

    #[tokio::test]
    async fn listing_on_renders_directory_index() {
        let (_dir, router) = router_with_hello(true);
        let (status, body) = get(router, "/").await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("hello.txt"), "index should list hello.txt");
        assert!(body.contains("Index of /"), "index should have a heading");
    }

    #[tokio::test]
    async fn listing_off_serves_file() {
        let (_dir, router) = router_with_hello(false);
        let (status, body) = get(router, "/hello.txt").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, "hello world");
    }

    #[tokio::test]
    async fn listing_on_missing_file_returns_404() {
        let (_dir, router) = router_with_hello(true);
        let (status, _) = get(router, "/nope.txt").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[test]
    fn html_escape_encodes_significant_characters() {
        assert_eq!(
            html_escape(r#"<img src=x onerror=alert(1)>"#),
            "&lt;img src=x onerror=alert(1)&gt;"
        );
        assert_eq!(html_escape(r#""><script>"#), "&quot;&gt;&lt;script&gt;");
        assert_eq!(html_escape("a&b'c"), "a&amp;b&#x27;c");
        // Ordinary names pass through unchanged.
        assert_eq!(html_escape("hello.txt"), "hello.txt");
    }

    /// SEC-007 / CORE-025 regression: a hostile filename must be HTML-escaped in
    /// the generated directory listing so it cannot inject a live tag.
    ///
    /// This exercises the listing-entry renderer directly with a synthetic name
    /// instead of writing a real file, so it runs identically on every platform.
    /// (A real file named `<img …>` cannot be created on Windows — `< > "` are
    /// illegal in Windows filenames — which is why the on-disk form was not
    /// portable.)
    #[test]
    fn listing_escapes_hostile_filename() {
        let hostile = r#"<img src=x onerror=alert(1)>.txt"#;
        let entry = render_listing_entry(hostile, false);
        // The raw, unescaped tag must NOT appear anywhere in the output.
        assert!(
            !entry.contains("<img src=x onerror=alert(1)>"),
            "hostile filename must not be emitted as a live tag: {entry}"
        );
        // The escaped form must be present instead, in both the href attribute
        // and the anchor text.
        assert!(
            entry.contains("&lt;img src=x onerror=alert(1)&gt;.txt"),
            "escaped filename should appear in the listing: {entry}"
        );

        // A hostile directory name is escaped and still gets its trailing slash.
        let hostile_dir = render_listing_entry(r#""><script>"#, true);
        assert!(
            !hostile_dir.contains("<script>"),
            "hostile dir name must not be emitted raw: {hostile_dir}"
        );
        assert!(
            hostile_dir.contains("&quot;&gt;&lt;script&gt;/"),
            "escaped dir name should keep its trailing slash: {hostile_dir}"
        );
    }

    /// WA-RS-001 / CORE-001 regression: triggering the shutdown signal must stop
    /// the running server promptly via the event-driven path, not after the old
    /// fixed 100 ms poll interval.
    ///
    /// Binds a real HTTP server on an ephemeral loopback port, waits for the bind
    /// to confirm, then fires the signal and asserts the server thread returns
    /// cleanly and quickly.
    #[test]
    fn shutdown_signal_stops_server_promptly() {
        use crate::embedded_servers::config::ServerType;
        use std::time::{Duration, Instant};

        let dir = tempfile::tempdir().expect("create temp dir");
        let config = EmbeddedServerConfig {
            id: "test-http-shutdown".to_string(),
            name: "test".to_string(),
            server_type: ServerType::Http,
            root_directory: dir.path().to_string_lossy().into_owned(),
            bind_host: "127.0.0.1".to_string(),
            port: 0, // ephemeral — the test only needs a confirmed bind
            auto_start: false,
            read_only: false,
            directory_listing: Some(false),
            ftp_auth: None,
        };

        let shutdown = ShutdownSignal::new();
        let stats = AtomicServerStats::new();
        let (ready, ready_rx) = BindSignal::for_test();

        let server_shutdown = shutdown.clone();
        let handle =
            std::thread::spawn(move || start_http_server(&config, server_shutdown, stats, ready));

        // The server must confirm its bind before we signal shutdown.
        let bind = ready_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("server should confirm its bind");
        assert!(bind.is_ok(), "bind should succeed, got {bind:?}");

        // Fire the signal and confirm the server unwinds cleanly. The generous
        // bound only guards against a hang/regression; the event-driven wake
        // itself (sub-millisecond, no poll) is asserted in `shutdown` unit tests.
        let start = Instant::now();
        shutdown.trigger();
        let result = handle.join().expect("server thread should not panic");
        assert!(result.is_ok(), "server exited with error: {result:?}");
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "server did not stop promptly after the shutdown signal ({:?})",
            start.elapsed()
        );
    }

    /// SEC-007 regression: the reflected request path must be HTML-escaped in the
    /// `<title>`/`<h1>` so a crafted URL cannot reflect script into the page.
    #[test]
    fn directory_listing_escapes_reflected_url_path() {
        let dir = tempfile::tempdir().expect("create temp dir");
        let html = directory_listing_html(dir.path(), r#"/<script>alert(1)</script>/"#)
            .expect("render listing");
        assert!(
            !html.contains("<script>alert(1)</script>"),
            "reflected path must not be emitted raw: {html}"
        );
        assert!(
            html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"),
            "reflected path should be escaped: {html}"
        );
    }
}
