use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::task::{Context as TaskContext, Poll};
use std::time::Instant;

use anyhow::{Context, Result};
use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, State};
use axum::handler::Handler;
use axum::http::{header, HeaderMap, HeaderValue, Request, StatusCode};
use axum::middleware::Next;
use axum::response::{Html, IntoResponse, Response};
use axum::{middleware, Router};
use base64::Engine as _;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tower_http::services::ServeDir;

use super::activity::{AccessRecord, TransferGuard};
use super::config::{AtomicServerStats, EmbeddedServerConfig, HttpBasicAuth};
use super::service::BindSignal;
use super::shutdown::ShutdownSignal;

/// State shared with middleware for connection tracking.
#[derive(Clone)]
struct TrackingState {
    stats: Arc<AtomicServerStats>,
    /// Whether Basic auth is configured — only then is the (username part of
    /// the) `Authorization` header read for the access log.
    auth_enabled: bool,
}

/// Tower middleware that tracks active and total HTTP connections and records
/// one access-log entry per request (PROD-034).
///
/// The entry is finalised when the response body is fully streamed (or
/// dropped), so it carries the real byte count and the time to the last byte;
/// the download is listed as a current transfer meanwhile. Only the URI *path*
/// is logged — never the query string — and only the Basic-auth *username* of
/// an accepted request, never a password.
async fn track_connections(
    State(state): State<TrackingState>,
    req: Request<Body>,
    next: Next,
) -> Response {
    let started = Instant::now();
    let client = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ci| ci.0.ip());
    let method = req.method().to_string();
    let path = req.uri().path().to_string();
    let user = if state.auth_enabled {
        decode_basic_credentials(req.headers()).map(|(username, _password)| username)
    } else {
        None
    };

    state
        .stats
        .active_connections
        .fetch_add(1, Ordering::Relaxed);
    state
        .stats
        .total_connections
        .fetch_add(1, Ordering::Relaxed);

    let resp = next.run(req).await;

    state
        .stats
        .active_connections
        .fetch_sub(1, Ordering::Relaxed);

    let status = resp.status();
    // A rejected (401) attempt's username is not recorded as a user.
    let user = user.filter(|_| status != StatusCode::UNAUTHORIZED);
    let transfer = state
        .stats
        .activity
        .begin_transfer(&method, client, Some(&path));
    let pending = PendingAccess {
        stats: Arc::clone(&state.stats),
        transfer,
        started,
        client,
        user,
        method,
        path,
        status,
    };
    resp.map(|inner| {
        Body::new(LoggedBody {
            inner,
            finished: false,
            pending: Some(pending),
        })
    })
}

/// Everything needed to write a request's access-log entry once its response
/// body is done.
struct PendingAccess {
    stats: Arc<AtomicServerStats>,
    transfer: TransferGuard,
    started: Instant,
    client: Option<IpAddr>,
    user: Option<String>,
    method: String,
    path: String,
    status: StatusCode,
}

impl PendingAccess {
    /// Record the entry. `completed` is false when the body was dropped before
    /// its end (e.g. the client disconnected mid-download).
    fn finish(self, completed: bool) {
        let code = self.status.as_u16().to_string();
        let ok = completed && !(self.status.is_client_error() || self.status.is_server_error());
        let status = if completed {
            code
        } else {
            format!("{code} aborted")
        };
        let mut record = AccessRecord::new(self.method, status, ok)
            .path(self.path)
            .bytes(self.transfer.bytes())
            .elapsed_since(self.started);
        if let Some(ip) = self.client {
            record = record.client(ip);
        }
        if let Some(user) = self.user {
            record = record.user(user);
        }
        self.stats.activity.record(record);
    }
}

/// Response body wrapper that counts streamed bytes and records the request's
/// access-log entry when the body ends or is dropped (PROD-034).
struct LoggedBody {
    inner: Body,
    finished: bool,
    pending: Option<PendingAccess>,
}

impl http_body::Body for LoggedBody {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
        let polled = Pin::new(&mut self.inner).poll_frame(cx);
        match &polled {
            Poll::Ready(Some(Ok(frame))) => {
                if let Some(data) = frame.data_ref() {
                    let n = data.len() as u64;
                    if let Some(pending) = &self.pending {
                        pending.transfer.add_bytes(n);
                        pending.stats.bytes_sent.fetch_add(n, Ordering::Relaxed);
                    }
                }
            }
            Poll::Ready(None) => self.finished = true,
            _ => {}
        }
        polled
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> http_body::SizeHint {
        self.inner.size_hint()
    }
}

impl Drop for LoggedBody {
    fn drop(&mut self) {
        if let Some(pending) = self.pending.take() {
            let completed = self.finished || http_body::Body::is_end_stream(&self.inner);
            pending.finish(completed);
        }
    }
}

/// State shared with the Basic-auth middleware (PROD-0035).
#[derive(Clone)]
struct AuthState {
    /// The credentials a request must present.
    auth: Arc<HttpBasicAuth>,
    /// Pre-rendered `WWW-Authenticate` header value naming the server's realm.
    challenge: HeaderValue,
}

/// Tower middleware enforcing optional HTTP Basic authentication (PROD-0035).
///
/// A request whose `Authorization: Basic` credentials match is passed through
/// untouched; any other request (missing, malformed, or wrong credentials) is
/// answered with `401 Unauthorized` plus a `WWW-Authenticate: Basic` challenge
/// so a browser re-prompts. This layer is only mounted when a server has
/// `http_auth` configured — an unauthenticated server never sees it.
async fn require_basic_auth(
    State(state): State<AuthState>,
    req: Request<Body>,
    next: Next,
) -> Response {
    if credentials_match(&state.auth, req.headers()) {
        next.run(req).await
    } else {
        let mut resp = (StatusCode::UNAUTHORIZED, "401 Unauthorized\n").into_response();
        resp.headers_mut()
            .insert(header::WWW_AUTHENTICATE, state.challenge.clone());
        resp
    }
}

/// Build the `Basic realm="<name>"` challenge value for a server.
///
/// The realm is derived from the (user-controlled) server name, so it is
/// sanitised — quotes, backslashes and control characters removed — before
/// interpolation, and the result is validated as a header value; an
/// unrepresentable value falls back to a fixed `Basic realm="termiHub"` so the
/// challenge header is always well-formed.
fn basic_auth_challenge(realm: &str) -> HeaderValue {
    let sanitised: String = realm
        .chars()
        .filter(|c| *c != '"' && *c != '\\' && !c.is_control())
        .collect();
    HeaderValue::from_str(&format!("Basic realm=\"{sanitised}\""))
        .unwrap_or_else(|_| HeaderValue::from_static("Basic realm=\"termiHub\""))
}

/// True when the request's `Authorization: Basic` header carries credentials
/// matching `auth`. The comparison is constant-time (see [`secret_eq`]) and the
/// username/password checks are combined without short-circuiting, so neither a
/// wrong username nor a wrong password is distinguishable by timing.
fn credentials_match(auth: &HttpBasicAuth, headers: &HeaderMap) -> bool {
    let Some((username, password)) = decode_basic_credentials(headers) else {
        return false;
    };
    let user_ok = secret_eq(username.as_bytes(), auth.username.as_bytes());
    let pass_ok = secret_eq(password.as_bytes(), auth.password.as_bytes());
    (user_ok & pass_ok).into()
}

/// Decode `Authorization: Basic <base64(user:pass)>` into its `(username,
/// password)` pair, or `None` when the header is absent, not the `Basic` scheme,
/// not valid base64/UTF-8, or missing the `:` separator. The scheme token is
/// matched case-insensitively per RFC 7617.
fn decode_basic_credentials(headers: &HeaderMap) -> Option<(String, String)> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, encoded) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("Basic") {
        return None;
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .ok()?;
    let decoded = String::from_utf8(decoded).ok()?;
    let (username, password) = decoded.split_once(':')?;
    Some((username.to_string(), password.to_string()))
}

/// Constant-time equality of two secrets.
///
/// Each side is first reduced to a fixed-length SHA-256 digest, then the two
/// digests are compared in constant time. Hashing first makes the comparison
/// constant-time regardless of input length, so the secret's length cannot leak
/// through the early-exit on a length mismatch that a direct slice comparison
/// would expose.
fn secret_eq(a: &[u8], b: &[u8]) -> subtle::Choice {
    let da = Sha256::digest(a);
    let db = Sha256::digest(b);
    da.as_slice().ct_eq(db.as_slice())
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
///
/// When `auth` is `Some`, a Basic-auth gate (PROD-0035) is mounted in front of
/// the file service, challenging every request with the `realm`-named
/// `WWW-Authenticate` header until valid credentials are supplied; `None` leaves
/// the server unauthenticated exactly as before. The auth gate sits *inside* the
/// connection tracker so challenged (401) requests are still counted.
fn build_router(
    root: PathBuf,
    directory_listing: bool,
    tracking_state: TrackingState,
    auth: Option<HttpBasicAuth>,
    realm: &str,
) -> Router {
    let mut router = if directory_listing {
        let serve_dir = ServeDir::new(root.clone())
            .append_index_html_on_directories(false)
            .fallback(dir_listing_handler.with_state(root));
        Router::new().fallback_service(serve_dir)
    } else {
        Router::new().fallback_service(ServeDir::new(root))
    };

    if let Some(auth) = auth {
        router = router.layer(middleware::from_fn_with_state(
            AuthState {
                auth: Arc::new(auth),
                challenge: basic_auth_challenge(realm),
            },
            require_basic_auth,
        ));
    }

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
    // Optional Basic auth (PROD-0035): `None` serves unauthenticated as before.
    // The realm shown in the browser prompt is the server's display name.
    let auth = config.http_auth.clone();
    let realm = config.name.clone();
    let tracking_state = TrackingState {
        stats: stats.clone(),
        auth_enabled: auth.is_some(),
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

        let router = build_router(root, directory_listing, tracking_state, auth, &realm);

        tracing::info!(addr = %addr, "HTTP server listening");

        // Connect info exposes each request's peer address to the access log.
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
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
        router_with_hello_auth(directory_listing, None)
    }

    /// As [`router_with_hello`], but with optional Basic-auth credentials mounted
    /// (PROD-0035). The realm is a fixed test string.
    fn router_with_hello_auth(
        directory_listing: bool,
        auth: Option<HttpBasicAuth>,
    ) -> (tempfile::TempDir, Router) {
        let (dir, router, _stats) = router_with_stats(directory_listing, auth);
        (dir, router)
    }

    /// As [`router_with_hello_auth`], also returning the stats (and access log)
    /// the router records into.
    fn router_with_stats(
        directory_listing: bool,
        auth: Option<HttpBasicAuth>,
    ) -> (tempfile::TempDir, Router, Arc<AtomicServerStats>) {
        let dir = tempfile::tempdir().expect("create temp dir");
        std::fs::write(dir.path().join("hello.txt"), "hello world").expect("write file");
        let stats = AtomicServerStats::new();
        let tracking_state = TrackingState {
            stats: Arc::clone(&stats),
            auth_enabled: auth.is_some(),
        };
        let router = build_router(
            dir.path().to_path_buf(),
            directory_listing,
            tracking_state,
            auth,
            "Test Realm",
        );
        (dir, router, stats)
    }

    /// All access-log entries recorded so far.
    fn log_entries(
        stats: &AtomicServerStats,
    ) -> Vec<crate::embedded_servers::activity::AccessLogEntry> {
        stats.activity.snapshot(None, &stats.snapshot()).entries
    }

    async fn get(router: Router, uri: &str) -> (StatusCode, String) {
        let (status, _headers, body) = get_full(router, uri, None).await;
        (status, body)
    }

    /// Perform a GET with an optional `Authorization` header, returning the
    /// status, response headers, and body.
    async fn get_full(
        router: Router,
        uri: &str,
        authorization: Option<&str>,
    ) -> (StatusCode, axum::http::HeaderMap, String) {
        let mut builder = Request::builder().uri(uri);
        if let Some(value) = authorization {
            builder = builder.header(axum::http::header::AUTHORIZATION, value);
        }
        let response = router
            .oneshot(builder.body(Body::empty()).expect("build request"))
            .await
            .expect("router response");
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("read body");
        (
            status,
            headers,
            String::from_utf8_lossy(&bytes).into_owned(),
        )
    }

    /// Encode `user:pass` into the value of an `Authorization: Basic` header.
    fn basic_header(username: &str, password: &str) -> String {
        let token =
            base64::engine::general_purpose::STANDARD.encode(format!("{username}:{password}"));
        format!("Basic {token}")
    }

    fn creds(username: &str, password: &str) -> HttpBasicAuth {
        HttpBasicAuth {
            username: username.to_string(),
            password: password.to_string(),
        }
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

    // ─── HTTP Basic auth (PROD-0035) ────────────────────────────────────────

    /// With auth configured, a request carrying no credentials is challenged
    /// with `401` and a `WWW-Authenticate: Basic realm="…"` header.
    #[tokio::test]
    async fn auth_missing_credentials_returns_401_challenge() {
        let (_dir, router) = router_with_hello_auth(false, Some(creds("admin", "s3cret")));
        let (status, headers, _) = get_full(router, "/hello.txt", None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let challenge = headers
            .get(axum::http::header::WWW_AUTHENTICATE)
            .and_then(|v| v.to_str().ok())
            .expect("challenge header present");
        assert_eq!(challenge, r#"Basic realm="Test Realm""#);
    }

    /// With auth configured, wrong credentials are also rejected with `401`.
    #[tokio::test]
    async fn auth_wrong_credentials_returns_401() {
        let (_dir, router) = router_with_hello_auth(false, Some(creds("admin", "s3cret")));
        let (status, _headers, _) =
            get_full(router, "/hello.txt", Some(&basic_header("admin", "wrong"))).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    /// A wrong username (right password) is rejected too.
    #[tokio::test]
    async fn auth_wrong_username_returns_401() {
        let (_dir, router) = router_with_hello_auth(false, Some(creds("admin", "s3cret")));
        let (status, _headers, _) =
            get_full(router, "/hello.txt", Some(&basic_header("root", "s3cret"))).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    /// With auth configured, correct credentials serve the file normally.
    #[tokio::test]
    async fn auth_correct_credentials_serves_file() {
        let (_dir, router) = router_with_hello_auth(false, Some(creds("admin", "s3cret")));
        let (status, _headers, body) =
            get_full(router, "/hello.txt", Some(&basic_header("admin", "s3cret"))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, "hello world");
    }

    /// A malformed (non-Basic) Authorization header is rejected, not mistaken
    /// for valid credentials.
    #[tokio::test]
    async fn auth_non_basic_scheme_returns_401() {
        let (_dir, router) = router_with_hello_auth(false, Some(creds("admin", "s3cret")));
        let (status, _headers, _) = get_full(router, "/hello.txt", Some("Bearer sometoken")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    /// With no auth configured (the default, backward-compatible shape), the
    /// server serves unauthenticated and never emits a challenge.
    #[tokio::test]
    async fn auth_disabled_serves_unauthenticated() {
        let (_dir, router) = router_with_hello_auth(false, None);
        let (status, headers, body) = get_full(router, "/hello.txt", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, "hello world");
        assert!(headers.get(axum::http::header::WWW_AUTHENTICATE).is_none());
    }

    /// The scheme token is matched case-insensitively per RFC 7617.
    #[tokio::test]
    async fn auth_scheme_is_case_insensitive() {
        let (_dir, router) = router_with_hello_auth(false, Some(creds("admin", "s3cret")));
        let token = base64::engine::general_purpose::STANDARD.encode("admin:s3cret");
        let (status, _headers, _) =
            get_full(router, "/hello.txt", Some(&format!("basic {token}"))).await;
        assert_eq!(status, StatusCode::OK);
    }

    /// A password containing a colon round-trips: only the first `:` splits the
    /// decoded `user:pass`, so the rest stays in the password.
    #[tokio::test]
    async fn auth_password_may_contain_colon() {
        let (_dir, router) = router_with_hello_auth(false, Some(creds("admin", "a:b:c")));
        let (status, _headers, _) =
            get_full(router, "/hello.txt", Some(&basic_header("admin", "a:b:c"))).await;
        assert_eq!(status, StatusCode::OK);
    }

    /// The realm value is sanitised so a hostile server name cannot produce a
    /// malformed `WWW-Authenticate` header (quotes/backslashes stripped).
    #[test]
    fn basic_auth_challenge_sanitises_realm() {
        let value = basic_auth_challenge(r#"na"me\with"#);
        assert_eq!(
            value.to_str().expect("valid header"),
            r#"Basic realm="namewith""#
        );
    }

    // ─── Access log (PROD-034) ──────────────────────────────────────────────

    #[tokio::test]
    async fn access_log_records_successful_download() {
        let (_dir, router, stats) = router_with_stats(false, None);
        let (status, body) = get(router, "/hello.txt").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, "hello world");

        let entries = log_entries(&stats);
        assert_eq!(entries.len(), 1);
        let e = &entries[0];
        assert_eq!(e.method, "GET");
        assert_eq!(e.path.as_deref(), Some("/hello.txt"));
        assert_eq!(e.status, "200");
        assert!(e.success);
        assert_eq!(e.bytes, 11);
        assert!(e.duration_ms.is_some());
        // Real streamed bytes feed the aggregate counter too.
        assert_eq!(stats.snapshot().bytes_sent, 11);
        // The finished download is no longer a current transfer.
        let snap = stats.activity.snapshot(None, &stats.snapshot());
        assert!(snap.stats.current_transfers.is_empty());
    }

    #[tokio::test]
    async fn access_log_records_missing_file_as_error() {
        let (_dir, router, stats) = router_with_stats(true, None);
        let (status, _) = get(router, "/nope.txt").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let entries = log_entries(&stats);
        assert_eq!(entries[0].status, "404");
        assert!(!entries[0].success);
        let snap = stats.activity.snapshot(None, &stats.snapshot());
        assert_eq!(snap.stats.errors, 1);
        assert_eq!(snap.stats.top_paths[0].key, "/nope.txt");
    }

    #[tokio::test]
    async fn access_log_never_records_query_string() {
        let (_dir, router, stats) = router_with_stats(false, None);
        let _ = get(router, "/hello.txt?token=supersecret").await;
        let entries = log_entries(&stats);
        assert_eq!(entries[0].path.as_deref(), Some("/hello.txt"));
        let json = serde_json::to_string(&entries).expect("serialize");
        assert!(!json.contains("supersecret"), "query leaked: {json}");
    }

    #[tokio::test]
    async fn access_log_records_username_but_never_password() {
        let (_dir, router, stats) = router_with_stats(false, Some(creds("admin", "s3cret-pw")));
        // One accepted and one rejected attempt.
        let (ok, _, _) = get_full(
            router.clone(),
            "/hello.txt",
            Some(&basic_header("admin", "s3cret-pw")),
        )
        .await;
        assert_eq!(ok, StatusCode::OK);
        let (denied, _, _) = get_full(
            router,
            "/hello.txt",
            Some(&basic_header("mallory", "s3cret-guess")),
        )
        .await;
        assert_eq!(denied, StatusCode::UNAUTHORIZED);

        let entries = log_entries(&stats);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].user.as_deref(), Some("admin"));
        assert_eq!(entries[1].status, "401");
        assert!(!entries[1].success);
        assert!(
            entries[1].user.is_none(),
            "rejected user must not be recorded"
        );
        let json = serde_json::to_string(&entries).expect("serialize");
        assert!(
            !json.contains("s3cret"),
            "password leaked into the log: {json}"
        );
        assert!(!json.contains("Basic "), "auth header leaked: {json}");
    }

    /// End-to-end over a real socket: the peer address reaches the log via
    /// connect info.
    #[test]
    fn access_log_records_client_address_over_real_socket() {
        use crate::embedded_servers::config::ServerType;
        use std::io::{Read, Write};
        use std::time::Duration;

        let dir = tempfile::tempdir().expect("create temp dir");
        std::fs::write(dir.path().join("fw.bin"), "firmware").expect("write file");
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .and_then(|l| l.local_addr())
            .expect("free port")
            .port();
        let config = EmbeddedServerConfig {
            id: "test-http-log".to_string(),
            name: "test".to_string(),
            server_type: ServerType::Http,
            root_directory: dir.path().to_string_lossy().into_owned(),
            bind_host: "127.0.0.1".to_string(),
            port,
            auto_start: false,
            read_only: true,
            directory_listing: Some(false),
            ftp_auth: None,
            http_auth: None,
            max_transfer_bytes: None,
        };
        let shutdown = ShutdownSignal::new();
        let stats = AtomicServerStats::new();
        let (ready, ready_rx) = BindSignal::for_test();
        let server_shutdown = shutdown.clone();
        let server_stats = Arc::clone(&stats);
        let handle = std::thread::spawn(move || {
            start_http_server(&config, server_shutdown, server_stats, ready)
        });
        let bind = ready_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("server should confirm its bind");
        assert!(bind.is_ok(), "bind failed: {bind:?}");

        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).expect("connect");
        stream
            .write_all(b"GET /fw.bin HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
            .expect("send request");
        let mut response = String::new();
        stream.read_to_string(&mut response).expect("read response");
        assert!(response.ends_with("firmware"), "response: {response}");

        // The entry is written when the body finishes streaming; allow the
        // server thread a moment to drop it.
        let mut entries = Vec::new();
        for _ in 0..100 {
            entries = log_entries(&stats);
            if !entries.is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        shutdown.trigger();
        let _ = handle.join();

        assert_eq!(entries.len(), 1, "expected one entry, got {entries:?}");
        assert_eq!(entries[0].client.as_deref(), Some("127.0.0.1"));
        assert_eq!(entries[0].path.as_deref(), Some("/fw.bin"));
        assert_eq!(entries[0].bytes, 8);
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
            http_auth: None,
            max_transfer_bytes: None,
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
