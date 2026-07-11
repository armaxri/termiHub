//! Spawn IPC server: listens on the per-user rendezvous endpoint and invokes a
//! handler for each received [`SpawnRequest`] (#1364).
//!
//! Framing is newline-delimited JSON: the client writes one `SpawnRequest` line,
//! the server replies with one `SpawnResponse` line, then the connection closes.
//! The cross-platform transport (Unix socket / Windows named pipe) and NDJSON
//! framing come from the shared [`termihub_core::ipc`] helper (#1386).

use anyhow::Context;
use termihub_core::ipc::{self, LocalSocketListener};
use tokio::io::{AsyncRead, AsyncWrite, BufReader};

use super::{SpawnEndpoint, SpawnHandler, SpawnRequest, SpawnResponse};

/// Serve spawn requests forever on `endpoint`, invoking `handler` per request.
///
/// Returns only on a fatal transport error (e.g. the endpoint is already owned
/// by another instance); the caller should treat that as "not the rendezvous".
pub async fn serve(endpoint: &SpawnEndpoint, handler: SpawnHandler) -> anyhow::Result<()> {
    let mut listener = LocalSocketListener::bind(endpoint.address())
        .await
        .with_context(|| format!("bind spawn endpoint {endpoint}"))?;
    loop {
        let (reader, writer) = listener.accept().await.context("accept spawn connection")?;
        let handler = handler.clone();
        tokio::spawn(async move {
            if let Err(e) = serve_halves(reader, writer, &handler).await {
                tracing::warn!("spawn connection error: {e}");
            }
        });
    }
}

/// Handle a single client connection over a combined stream: split it and run
/// the request/response worker. A test-only convenience so the transport is
/// exercised via an in-memory `tokio::io::duplex` pair on every platform; the
/// production path calls [`serve_halves`] directly with the listener's halves.
#[cfg(test)]
pub(crate) async fn serve_connection<S>(stream: S, handler: &SpawnHandler) -> anyhow::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (reader, writer) = tokio::io::split(stream);
    serve_halves(reader, writer, handler).await
}

/// Request/response worker over already-split read/write halves.
async fn serve_halves<R, W>(reader: R, mut writer: W, handler: &SpawnHandler) -> anyhow::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut reader = BufReader::new(reader);
    let mut line = String::new();
    let read = ipc::read_line(&mut reader, &mut line)
        .await
        .context("read spawn request")?;
    if read == 0 || line.trim().is_empty() {
        return Ok(());
    }

    let response = match serde_json::from_str::<SpawnRequest>(line.trim()) {
        Ok(req) => handler(req),
        Err(e) => SpawnResponse::error(format!("invalid spawn request: {e}")),
    };

    let payload = serde_json::to_string(&response).context("serialize spawn response")?;
    ipc::write_line(&mut writer, &payload)
        .await
        .context("write spawn response")?;
    Ok(())
}
