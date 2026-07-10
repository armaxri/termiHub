//! Spawn IPC server: listens on the per-user rendezvous endpoint and invokes a
//! handler for each received [`SpawnRequest`] (#1364).
//!
//! Framing is newline-delimited JSON: the client writes one `SpawnRequest` line,
//! the server replies with one `SpawnResponse` line, then the connection closes.

use anyhow::Context;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use super::{SpawnEndpoint, SpawnHandler, SpawnRequest, SpawnResponse};

/// Serve spawn requests forever on `endpoint`, invoking `handler` per request.
///
/// Returns only on a fatal transport error (e.g. the endpoint is already owned
/// by another instance); the caller should treat that as "not the rendezvous".
pub async fn serve(endpoint: &SpawnEndpoint, handler: SpawnHandler) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        serve_unix(endpoint.address(), handler).await
    }
    #[cfg(windows)]
    {
        serve_windows(endpoint.address(), handler).await
    }
}

/// Handle a single client connection: read one request line, run the handler,
/// write one response line. Generic over the stream so it is exercised in tests
/// via an in-memory `tokio::io::duplex` pair on every platform.
pub(crate) async fn serve_connection<S>(stream: S, handler: &SpawnHandler) -> anyhow::Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (reader, mut writer) = tokio::io::split(stream);
    let mut reader = BufReader::new(reader);
    let mut line = String::new();
    let read = reader
        .read_line(&mut line)
        .await
        .context("read spawn request")?;
    if read == 0 || line.trim().is_empty() {
        return Ok(());
    }

    let response = match serde_json::from_str::<SpawnRequest>(line.trim()) {
        Ok(req) => handler(req),
        Err(e) => SpawnResponse::error(format!("invalid spawn request: {e}")),
    };

    let mut payload = serde_json::to_string(&response).context("serialize spawn response")?;
    payload.push('\n');
    writer
        .write_all(payload.as_bytes())
        .await
        .context("write spawn response")?;
    writer.flush().await.context("flush spawn response")?;
    Ok(())
}

#[cfg(unix)]
async fn serve_unix(path: &str, handler: SpawnHandler) -> anyhow::Result<()> {
    use tokio::net::{UnixListener, UnixStream};

    let path = std::path::Path::new(path);
    // Clear a stale socket left behind by a crashed instance: if nothing is
    // listening, the connect fails and the file is safe to remove.
    if path.exists() && UnixStream::connect(path).await.is_err() {
        std::fs::remove_file(path).ok();
    }

    let listener = UnixListener::bind(path)
        .with_context(|| format!("bind spawn socket at {}", path.display()))?;
    loop {
        let (stream, _addr) = listener.accept().await.context("accept spawn connection")?;
        let handler = handler.clone();
        tokio::spawn(async move {
            if let Err(e) = serve_connection(stream, &handler).await {
                tracing::warn!("spawn connection error: {e}");
            }
        });
    }
}

#[cfg(windows)]
async fn serve_windows(name: &str, handler: SpawnHandler) -> anyhow::Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;

    // `first_pipe_instance(true)` fails if another instance already owns the
    // pipe — exactly the "not the rendezvous" signal we want.
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .create(name)
        .with_context(|| format!("create spawn pipe {name}"))?;
    loop {
        server.connect().await.context("await spawn pipe client")?;
        let connected = server;
        // Pre-create the next instance before handling this one so no client
        // races into a missing pipe.
        server = ServerOptions::new()
            .create(name)
            .with_context(|| format!("recreate spawn pipe {name}"))?;
        let handler = handler.clone();
        tokio::spawn(async move {
            if let Err(e) = serve_connection(connected, &handler).await {
                tracing::warn!("spawn connection error: {e}");
            }
        });
    }
}
