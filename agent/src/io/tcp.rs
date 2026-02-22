use std::sync::Arc;

use tokio::io::BufReader;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::handler::dispatch::Dispatcher;
use crate::io::transport::run_transport_loop;
use crate::monitoring::MonitoringManager;
use crate::protocol::messages::JsonRpcNotification;
use crate::registry::build_registry;
use crate::session::definitions::ConnectionStore;
use crate::session::manager::SessionManager;

/// Run the NDJSON transport loop over a TCP listener.
///
/// Binds to `addr`, accepts one client at a time, and runs the
/// JSON-RPC transport loop for each connection. The `SessionManager`
/// and notification channel are shared across connections so sessions
/// persist when a client disconnects and reconnects.
///
/// The accept loop exits when the cancellation token is triggered.
pub async fn run_tcp_listener(addr: &str, shutdown: CancellationToken) -> anyhow::Result<()> {
    let listener = TcpListener::bind(addr).await?;
    info!("Listening on {}", listener.local_addr()?);

    let (notification_tx, mut notification_rx) =
        tokio::sync::mpsc::unbounded_channel::<JsonRpcNotification>();
    let registry = Arc::new(build_registry());
    let session_manager = Arc::new(SessionManager::new(notification_tx.clone(), registry));
    let connection_store = Arc::new(ConnectionStore::new(ConnectionStore::default_path()));
    let monitoring_manager = Arc::new(MonitoringManager::new(
        notification_tx,
        connection_store.clone(),
    ));

    // Ensure default shell connection exists on first run
    connection_store.ensure_default_shell().await;

    // Recover sessions from previous agent run
    #[cfg(unix)]
    session_manager.recover_sessions().await;

    loop {
        tokio::select! {
            _ = shutdown.cancelled() => {
                info!("Shutdown signal received, stopping TCP listener");
                break;
            }

            accept_result = listener.accept() => {
                let (stream, peer) = accept_result?;
                info!("Client connected from {}", peer);

                // Drain stale notifications from previous connection.
                // Buffered data is preserved in serial ring buffers and
                // replayed on attach, so these are not needed.
                while notification_rx.try_recv().is_ok() {}

                let mut dispatcher = Dispatcher::new(session_manager.clone(), connection_store.clone(), monitoring_manager.clone());

                let (reader_half, mut writer_half) = stream.into_split();
                let mut reader = BufReader::new(reader_half);

                let result = run_transport_loop(
                    &mut reader,
                    &mut writer_half,
                    &mut dispatcher,
                    &mut notification_rx,
                    shutdown.child_token(),
                )
                .await;

                match result {
                    Ok(()) => info!("Client {} disconnected", peer),
                    Err(e) => warn!("Client {} error: {}", peer, e),
                }

                // Detach all sessions so they remain alive for the next client
                session_manager.detach_all().await;
            }
        }
    }

    // Agent shutting down: stop monitoring and close all sessions
    info!("Shutting down — stopping monitoring and closing all sessions");
    monitoring_manager.shutdown().await;
    session_manager.close_all().await;

    Ok(())
}
