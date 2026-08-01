use std::sync::Arc;

use tokio::io::BufReader;
use tokio_util::sync::CancellationToken;
use tracing::info;

use crate::handler::dispatch::AgentHandler;
use crate::io::transport::run_transport_loop;
use crate::monitoring::{MonitoringManager, MonitoringManagerApi};
use crate::protocol::messages::JsonRpcNotification;
use crate::registry::build_registry;
use crate::registry_daemon::client::{RegistryClient, RegistryConfig};
use crate::session::definitions::{ConnectionStore, ConnectionStoreApi};
use crate::session::manager::SessionManager;

/// Run the NDJSON stdio transport loop.
///
/// Reads JSON-RPC messages from stdin (one per line) and writes
/// responses to stdout. Backend notifications are interleaved via
/// a `tokio::select!` loop. Logs go to stderr.
pub async fn run_stdio_loop(
    shutdown: CancellationToken,
    allow_self_update: bool,
    update_strategy: crate::update::UpdateStrategy,
) -> anyhow::Result<()> {
    let (notification_tx, mut notification_rx) =
        tokio::sync::mpsc::unbounded_channel::<JsonRpcNotification>();

    let registry = Arc::new(build_registry());
    let session_manager = SessionManager::new(notification_tx.clone(), registry).into_arc();
    let connection_store = Arc::new(ConnectionStore::new(ConnectionStore::default_path()));
    let update_tx = notification_tx.clone();
    let test_update_tx = notification_tx.clone();
    let registry_tx = notification_tx.clone();
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

    // Test-only (#1546): arm the deferred-update E2E hook when the env gate is
    // set. Seeded AFTER `SessionManager::new` so the #1551 startup prune has
    // already run and cannot sweep the record we just staged. `None` — and so a
    // completely untouched code path — in production.
    if let Some(test_update) = crate::update::TestPendingUpdate::from_env() {
        test_update.seed(&session_manager).await;
        // stdio serves exactly one client, which attaches as this loop starts;
        // the channel is unbounded, so a send before the loop is delivered to it.
        test_update.notify_attached(&test_update_tx, env!("CARGO_PKG_VERSION"));
    }

    // Join the host-wide registry (ADR-11) so this worker's client is visible to
    // the host's other desktops, and cross-worker broadcasts reach ours. Started
    // before the loop and connected in the background: the registry is optional
    // infrastructure, so this must not delay serving the client.
    let registry_client = Arc::new(RegistryClient::start(
        RegistryConfig::default(),
        registry_tx,
        shutdown.child_token(),
    ));

    let handler = AgentHandler::new(
        session_manager.clone(),
        connection_store.clone() as Arc<dyn ConnectionStoreApi>,
        monitoring_manager.clone() as Arc<dyn MonitoringManagerApi>,
    )?
    .with_registry_client(registry_client);

    let stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let mut reader = BufReader::new(stdin);

    info!("Stdio transport loop started, waiting for input");

    let loop_result = run_transport_loop(
        &mut reader,
        &mut stdout,
        &handler,
        &mut notification_rx,
        shutdown,
    )
    .await;

    // The single client for this process has disconnected — clear it from the
    // registry before propagating any transport error.
    handler.deregister_client();
    loop_result?;

    // Graceful shutdown: stop monitoring and close all sessions
    info!("Shutting down — stopping monitoring and closing all sessions");
    monitoring_manager.shutdown().await;
    session_manager.close_all().await;

    Ok(())
}
