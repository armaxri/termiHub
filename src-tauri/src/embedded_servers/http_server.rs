use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::middleware::Next;
use axum::response::{Html, IntoResponse, Response};
use axum::{middleware, Router};
use tower_http::services::ServeDir;

use super::config::{AtomicServerStats, EmbeddedServerConfig};

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
        let suffix = if is_dir { "/" } else { "" };
        items.push(format!(
            r#"<li><a href="{name}{suffix}">{name}{suffix}</a></li>"#
        ));
    }

    let listing = items.join("\n        ");
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

/// Handler for directory listing requests.
async fn dir_listing_handler(
    axum::extract::OriginalUri(uri): axum::extract::OriginalUri,
    axum::extract::Extension(root): axum::extract::Extension<PathBuf>,
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
        // Not a directory — let ServeDir handle it.
        return StatusCode::NOT_FOUND.into_response();
    }
    match directory_listing_html(&full_path, url_path) {
        Ok(html) => Html(html).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// Start and run the HTTP server, blocking until the shutdown flag is set.
///
/// The function must be called from within a dedicated std thread that builds
/// its own tokio runtime.
pub fn start_http_server(
    config: &EmbeddedServerConfig,
    shutdown: Arc<AtomicBool>,
    stats: Arc<AtomicServerStats>,
) -> Result<()> {
    let addr: SocketAddr = format!("{}:{}", config.bind_host, config.port)
        .parse()
        .context("Invalid bind address")?;

    let root = PathBuf::from(&config.root_directory);
    let directory_listing = config.directory_listing.unwrap_or(false);
    let tracking_state = TrackingState {
        stats: stats.clone(),
    };

    // Build a tokio current-thread runtime in this thread.
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("Failed to build async runtime")?;

    rt.block_on(async move {
        let listener = tokio::net::TcpListener::bind(addr)
            .await
            .context("Failed to bind HTTP server")?;

        let serve_dir = ServeDir::new(root.clone());

        let mut router = if directory_listing {
            Router::new()
                .route("/*path", axum::routing::get(dir_listing_handler))
                .route("/", axum::routing::get(dir_listing_handler))
                .layer(axum::Extension(root.clone()))
                .fallback_service(serve_dir)
        } else {
            Router::new().fallback_service(serve_dir)
        };

        router = router.layer(middleware::from_fn_with_state(
            tracking_state,
            track_connections,
        ));

        tracing::info!(addr = %addr, "HTTP server listening");

        axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                loop {
                    if shutdown.load(Ordering::Relaxed) {
                        break;
                    }
                    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                }
            })
            .await
            .context("HTTP server error")?;

        Ok::<(), anyhow::Error>(())
    })?;

    Ok(())
}
