//! A tiny local HTTP/1.1 fixture server for the plugin fetch tests (PROD-048).
//!
//! Serves a fixed route table from `127.0.0.1:<ephemeral>` over plain HTTP —
//! the fetch helpers accept `http://` only under `FetchPolicy::TEST_ALLOW_HTTP`.
//! Each connection answers one request and closes.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpListener;

/// One canned response.
#[derive(Clone)]
pub enum Route {
    /// `200 OK` with `Content-Length`.
    Body(Vec<u8>),
    /// `200 OK` without `Content-Length` — the body is delimited by closing the
    /// connection, so only the streaming cap can stop an oversize body.
    UnsizedBody(Vec<u8>),
    /// `302 Found` to the given absolute location.
    Redirect(String),
    /// A bare status code with an empty body.
    Status(u16),
}

/// A running fixture server; dropped with the test's runtime.
pub struct TestServer {
    base: String,
}

impl TestServer {
    /// Start serving `routes` (path → response). Unknown paths answer 404.
    pub async fn start(routes: Vec<(&str, Route)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let base = format!("http://{}", listener.local_addr().expect("addr"));
        let routes: Arc<HashMap<String, Route>> = Arc::new(
            routes
                .into_iter()
                .map(|(p, r)| (p.to_string(), r))
                .collect(),
        );
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let routes = Arc::clone(&routes);
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 1024];
                    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        match socket.read(&mut chunk).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => buf.extend_from_slice(&chunk[..n]),
                        }
                    }
                    let request = String::from_utf8_lossy(&buf);
                    let path = request.split_whitespace().nth(1).unwrap_or("/").to_string();
                    let (head, body) = match routes.get(&path).cloned() {
                        Some(Route::Body(body)) => (
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                body.len()
                            ),
                            body,
                        ),
                        Some(Route::UnsizedBody(body)) => (
                            "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_string(),
                            body,
                        ),
                        Some(Route::Redirect(location)) => (
                            format!(
                                "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                            ),
                            Vec::new(),
                        ),
                        Some(Route::Status(code)) => (
                            format!(
                                "HTTP/1.1 {code} Status\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                            ),
                            Vec::new(),
                        ),
                        None => (
                            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                                .to_string(),
                            Vec::new(),
                        ),
                    };
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(&body).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        Self { base }
    }

    /// The absolute `http://` URL of `path` on this server.
    pub fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }
}
