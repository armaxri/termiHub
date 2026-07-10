//! Spawn IPC client: connects to the per-user rendezvous endpoint, sends one
//! [`SpawnRequest`], and reads the [`SpawnResponse`] (#1364).

use anyhow::Context;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use super::{SpawnEndpoint, SpawnRequest, SpawnResponse};

/// Connect to `endpoint`, send `req`, and return the running instance's
/// response. Fails fast if no instance is listening.
pub async fn send(endpoint: &SpawnEndpoint, req: &SpawnRequest) -> anyhow::Result<SpawnResponse> {
    #[cfg(unix)]
    {
        let stream = tokio::net::UnixStream::connect(endpoint.address())
            .await
            .context("connect spawn socket")?;
        exchange(stream, req).await
    }
    #[cfg(windows)]
    {
        use tokio::net::windows::named_pipe::ClientOptions;
        let stream = ClientOptions::new()
            .open(endpoint.address())
            .context("open spawn pipe")?;
        exchange(stream, req).await
    }
}

/// Perform the request/response exchange over an established stream. Generic so
/// it is exercised in tests via an in-memory `tokio::io::duplex` pair on every
/// platform.
pub(crate) async fn exchange<S>(stream: S, req: &SpawnRequest) -> anyhow::Result<SpawnResponse>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (reader, mut writer) = tokio::io::split(stream);

    let mut payload = serde_json::to_string(req).context("serialize spawn request")?;
    payload.push('\n');
    writer
        .write_all(payload.as_bytes())
        .await
        .context("write spawn request")?;
    writer.flush().await.context("flush spawn request")?;

    let mut reader = BufReader::new(reader);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .await
        .context("read spawn response")?;
    serde_json::from_str(line.trim()).context("parse spawn response")
}
