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
use crate::registry_daemon::client::{RegistryClient, RegistryConfig};
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

    // Join the host-wide registry (ADR-11). One per process, shared by every
    // client this listener serves — the same lifetime as the `SessionManager`
    // above, and for the same reason: it is host state, not client state.
    let registry_client = Arc::new(RegistryClient::start(
        RegistryConfig::default(),
        registry_tx,
        shutdown.child_token(),
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
    let test_update = crate::update::TestPendingUpdate::from_env();
    if let Some(test_update) = test_update.as_ref() {
        test_update.seed(&session_manager).await;
    }

    // Test-only (#1579): stretch the startup window so a regression test can
    // observe the bind/accept ordering deterministically. `None` — and so a
    // zero-cost no-op — in production. Runs BEFORE the bind below so that the
    // simulated slow init happens while the port is still un-connectable,
    // exactly as the real #1551 startup work now does.
    startup_test_delay().await;

    // Bind and announce readiness only now, after all the startup work above
    // has finished (#1579). Binding earlier makes `Listening on …` a lie: the
    // kernel accepts connections into the listen backlog the instant the socket
    // is bound, so a client's `connect` succeeds while this task is still deep
    // in `SessionManager::new`'s #1551 binary byte-compare, `ensure_default_shell`
    // and `recover_sessions` — and then the client's `initialize` stalls with no
    // reader until the accept loop below is finally reached. By binding last, the
    // log line is a true readiness signal and an early client is cleanly refused
    // (the desktop retries with backoff) instead of accepted-then-stalled.
    let listener = TcpListener::bind(addr).await?;
    info!("Listening on {}", listener.local_addr()?);

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

                // Test-only (#1546): re-announce the staged update to the client
                // that just attached. This has to sit AFTER the drain above —
                // anything queued before a client connects is discarded — which
                // is exactly why a staged update is otherwise never replayed on
                // attach and the deferred path is unreachable from a live test.
                if let Some(test_update) = test_update.as_ref() {
                    test_update.notify_attached(&test_update_tx, env!("CARGO_PKG_VERSION"));
                }

                // As with accept(), a failure to build the per-connection
                // handler must not kill the listener — drop this client and keep
                // serving the rest.
                let handler = match AgentHandler::new(
                    session_manager.clone(),
                    connection_store.clone() as Arc<dyn ConnectionStoreApi>,
                    monitoring_manager.clone() as Arc<dyn MonitoringManagerApi>,
                ) {
                    Ok(handler) => handler.with_registry_client(registry_client.clone()),
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

/// Test-only startup delay gate (#1579).
///
/// When `TERMIHUB_TEST_STARTUP_DELAY_MS` is set to a positive integer, sleep
/// that many milliseconds on the startup path just before the listener binds.
/// This lets `agent/tests/tcp_listener_readiness.rs` reproduce the class of slow
/// init (`SessionManager::new`'s #1551 binary byte-compare, session recovery)
/// that made the accept-before-ready race observable, without depending on real
/// machine load. Unset in production, so this is a single failed env lookup.
async fn startup_test_delay() {
    if let Some(ms) = std::env::var("TERMIHUB_TEST_STARTUP_DELAY_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|ms| *ms > 0)
    {
        tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
    }
}
