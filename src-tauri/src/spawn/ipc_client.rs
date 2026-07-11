//! Spawn IPC client: connects to the per-user rendezvous endpoint, sends one
//! [`SpawnRequest`], and reads the [`SpawnResponse`] (#1364).
//!
//! The cross-platform transport (Unix socket / Windows named pipe) and NDJSON
//! framing come from the shared [`termihub_core::ipc`] helper (#1386).

use anyhow::Context;
use termihub_core::ipc;
use tokio::io::{AsyncRead, AsyncWrite, BufReader};

use super::{SpawnEndpoint, SpawnRequest, SpawnResponse};

/// Connect to `endpoint`, send `req`, and return the running instance's
/// response. Fails fast if no instance is listening.
pub async fn send(endpoint: &SpawnEndpoint, req: &SpawnRequest) -> anyhow::Result<SpawnResponse> {
    let (reader, writer) = ipc::connect(endpoint.address())
        .await
        .with_context(|| format!("connect spawn endpoint {endpoint}"))?;
    exchange_halves(reader, writer, req).await
}

/// Perform the request/response exchange over an established stream. Generic so
/// it is exercised in tests via an in-memory `tokio::io::duplex` pair on every
/// platform.
pub(crate) async fn exchange<S>(stream: S, req: &SpawnRequest) -> anyhow::Result<SpawnResponse>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (reader, writer) = tokio::io::split(stream);
    exchange_halves(reader, writer, req).await
}

/// Request/response exchange over already-split read/write halves.
async fn exchange_halves<R, W>(
    reader: R,
    mut writer: W,
    req: &SpawnRequest,
) -> anyhow::Result<SpawnResponse>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let payload = serde_json::to_string(req).context("serialize spawn request")?;
    ipc::write_line(&mut writer, &payload)
        .await
        .context("write spawn request")?;

    let mut reader = BufReader::new(reader);
    let mut line = String::new();
    ipc::read_line(&mut reader, &mut line)
        .await
        .context("read spawn response")?;
    serde_json::from_str(line.trim()).context("parse spawn response")
}
