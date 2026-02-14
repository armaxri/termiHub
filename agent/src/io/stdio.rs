use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tracing::{debug, info, warn};

use crate::handler::dispatch::Dispatcher;
use crate::protocol::errors;
use crate::protocol::messages::{JsonRpcErrorResponse, JsonRpcRequest};
use crate::session::manager::SessionManager;

/// Maximum message size: 1 MiB as defined by the protocol spec.
const MAX_LINE_SIZE: usize = 1_048_576;

/// Run the NDJSON stdio transport loop.
///
/// Reads JSON-RPC messages from stdin (one per line) and writes
/// responses to stdout. Logs go to stderr.
pub async fn run_stdio_loop() -> anyhow::Result<()> {
    let session_manager = Arc::new(SessionManager::new());
    let mut dispatcher = Dispatcher::new(session_manager);

    let stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let mut reader = BufReader::new(stdin);
    let mut line = String::new();

    info!("Stdio transport loop started, waiting for input");

    loop {
        line.clear();

        let bytes_read = reader.read_line(&mut line).await?;
        if bytes_read == 0 {
            // EOF — desktop closed the channel
            info!("Stdin closed, shutting down");
            break;
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Check message size limit
        if trimmed.len() > MAX_LINE_SIZE {
            warn!("Message exceeds 1 MiB limit ({} bytes)", trimmed.len());
            let err = JsonRpcErrorResponse::new(
                serde_json::Value::Null,
                errors::PARSE_ERROR,
                "Message exceeds 1 MiB size limit",
            );
            write_response(&mut stdout, &serde_json::to_value(&err)?).await?;
            continue;
        }

        debug!("Received: {}", trimmed);

        // Parse JSON
        let request: JsonRpcRequest = match serde_json::from_str(trimmed) {
            Ok(r) => r,
            Err(e) => {
                warn!("Failed to parse JSON-RPC request: {e}");
                let err = JsonRpcErrorResponse::new(
                    serde_json::Value::Null,
                    errors::PARSE_ERROR,
                    format!("Parse error: {e}"),
                );
                write_response(&mut stdout, &serde_json::to_value(&err)?).await?;
                continue;
            }
        };

        // Validate jsonrpc field
        if request.jsonrpc != "2.0" {
            let err = JsonRpcErrorResponse::new(
                request.id,
                errors::INVALID_REQUEST,
                "Invalid JSON-RPC version (must be \"2.0\")",
            );
            write_response(&mut stdout, &serde_json::to_value(&err)?).await?;
            continue;
        }

        // Dispatch and respond
        let result = dispatcher.dispatch(request).await;
        let response_json = result.to_json();

        debug!("Sending: {}", response_json);
        write_response(&mut stdout, &response_json).await?;
    }

    Ok(())
}

/// Write a JSON value as an NDJSON line to the writer.
async fn write_response<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    value: &serde_json::Value,
) -> anyhow::Result<()> {
    let mut line = serde_json::to_string(value)?;
    line.push('\n');
    writer.write_all(line.as_bytes()).await?;
    writer.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn write_response_appends_newline() {
        let mut buf: Vec<u8> = Vec::new();
        let value = serde_json::json!({"jsonrpc": "2.0", "result": {}, "id": 1});
        write_response(&mut buf, &value).await.unwrap();
        let output = String::from_utf8(buf).unwrap();
        assert!(output.ends_with('\n'));
        // Should be a single line
        assert_eq!(output.matches('\n').count(), 1);
        // Should be valid JSON (minus trailing newline)
        let parsed: serde_json::Value = serde_json::from_str(output.trim_end()).unwrap();
        assert_eq!(parsed["id"], 1);
    }
}
