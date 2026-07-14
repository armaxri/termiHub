use std::sync::Arc;

use tokio::io::BufReader;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::handler::dispatch::AgentHandler;
use crate::io::transport::run_transport_loop;
use crate::monitoring::{MonitoringManager, MonitoringManagerApi};
use crate::protocol::messages::JsonRpcNotification;
use crate::registry::build_registry;
use crate::session::definitions::{ConnectionStore, ConnectionStoreApi};
use crate::session::manager::SessionManager;

/// Run the NDJSON transport loop over a TCP listener.
///
/// Binds to `addr`, accepts one client at a time, and runs the
/// JSON-RPC transport loop for each connection. The `SessionManager`
/// and notification channel are shared across connections so sessions
/// persist when a client disconnects and reconnects.
///
/// The accept loop exits when the cancellation token is triggered.
pub async fn run_tcp_listener(
    addr: &str,
    shutdown: CancellationToken,
    allow_self_update: bool,
    update_strategy: crate::update::UpdateStrategy,
) -> anyhow::Result<()> {
    let listener = TcpListener::bind(addr).await?;
    info!("Listening on {}", listener.local_addr()?);

    let (notification_tx, mut notification_rx) =
        tokio::sync::mpsc::unbounded_channel::<JsonRpcNotification>();
    let registry = Arc::new(build_registry());
    let session_manager = Arc::new(SessionManager::new(notification_tx.clone(), registry));
    let connection_store = Arc::new(ConnectionStore::new(ConnectionStore::default_path()));
    let update_tx = notification_tx.clone();
    let monitoring_manager = Arc::new(MonitoringManager::new(
        notification_tx,
        connection_store.clone(),
    ));

    // Ensure default shell connection exists on first run
    connection_store.ensure_default_shell().await;

    // Recover sessions from previous agent run
    session_manager.recover_sessions().await;

    // Optional background GitHub self-update check (off unless opted in).
    crate::update::spawn_self_update_task(
        crate::update::UpdateConfig::from_env(
            allow_self_update,
            update_strategy,
            env!("CARGO_PKG_VERSION"),
        ),
        session_manager.clone(),
        update_tx,
        shutdown.child_token(),
    );

    loop {
        tokio::select! {
            _ = shutdown.cancelled() => {
                info!("Shutdown signal received, stopping TCP listener");
                break;
            }

            accept_result = listener.accept() => {
                // A transient accept() error (e.g. the peer aborted the pending
                // connection, or the process briefly hit its file-descriptor
                // limit under load) must not tear down the whole listener — that
                // would drop every other client and exit the agent. Log and keep
                // accepting; a short yield avoids a busy-spin if the condition
                // persists.
                let (stream, peer) = match accept_result {
                    Ok(conn) => conn,
                    Err(e) => {
                        warn!("accept() failed, continuing to listen: {}", e);
                        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                        continue;
                    }
                };
                info!("Client connected from {}", peer);

                // Drain stale notifications from previous connection.
                // Buffered data is preserved in serial ring buffers and
                // replayed on attach, so these are not needed.
                while notification_rx.try_recv().is_ok() {}

                // As with accept(), a failure to build the per-connection
                // handler must not kill the listener — drop this client and keep
                // serving the rest.
                let handler = match AgentHandler::new(
                    session_manager.clone(),
                    connection_store.clone() as Arc<dyn ConnectionStoreApi>,
                    monitoring_manager.clone() as Arc<dyn MonitoringManagerApi>,
                ) {
                    Ok(handler) => handler,
                    Err(e) => {
                        warn!("failed to build handler for {}, dropping client: {}", peer, e);
                        continue;
                    }
                };

                let (reader_half, mut writer_half) = stream.into_split();
                let mut reader = BufReader::new(reader_half);

                let result = run_transport_loop(
                    &mut reader,
                    &mut writer_half,
                    &handler,
                    &mut notification_rx,
                    shutdown.child_token(),
                )
                .await;

                match result {
                    Ok(()) => info!("Client {} disconnected", peer),
                    Err(e) => warn!("Client {} error: {}", peer, e),
                }

                // Clear this client from the registry now that its connection
                // has ended (the handler is per-connection in listen mode).
                handler.deregister_client();

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
