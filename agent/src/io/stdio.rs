use std::sync::Arc;

use tokio::io::BufReader;
use tokio_util::sync::CancellationToken;
use tracing::info;

use crate::handler::dispatch::Dispatcher;
use crate::io::transport::run_transport_loop;
use crate::protocol::messages::JsonRpcNotification;
use crate::session::definitions::DefinitionStore;
use crate::session::manager::SessionManager;

/// Run the NDJSON stdio transport loop.
///
/// Reads JSON-RPC messages from stdin (one per line) and writes
/// responses to stdout. Backend notifications are interleaved via
/// a `tokio::select!` loop. Logs go to stderr.
pub async fn run_stdio_loop(shutdown: CancellationToken) -> anyhow::Result<()> {
    let (notification_tx, mut notification_rx) =
        tokio::sync::mpsc::unbounded_channel::<JsonRpcNotification>();

    let session_manager = Arc::new(SessionManager::new(notification_tx));
    let definition_store = Arc::new(DefinitionStore::new(DefinitionStore::default_path()));
    let mut dispatcher = Dispatcher::new(session_manager.clone(), definition_store);

    let stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let mut reader = BufReader::new(stdin);

    info!("Stdio transport loop started, waiting for input");

    run_transport_loop(
        &mut reader,
        &mut stdout,
        &mut dispatcher,
        &mut notification_rx,
        shutdown,
    )
    .await?;

    // Graceful shutdown: close all sessions
    info!("Shutting down — closing all sessions");
    session_manager.close_all().await;

    Ok(())
}
