//! The host-wide registry daemon process (`termihub-agent --registry-daemon`).
//!
//! One per user per host (ADR-11). Agent workers connect to it, announce the
//! client they serve, ask it who else is connected, and fan notifications out
//! through it. It is a **rendezvous**, not a proxy: it holds no sessions, no
//! PTYs and no buffers, only the client set and the broadcast fan-out.
//!
//! Three things distinguish it from the per-session daemon role it shares its
//! substrate with:
//!
//! - **Many concurrent connections.** A session daemon owns a PTY, so a second
//!   attach *takes over* (`daemon/process.rs` evicts the previous worker on
//!   every `accept`). A registry with takeover semantics would be pointless —
//!   the whole job is holding several workers at once — so each connection gets
//!   its own task and its own writer, and none evicts another.
//! - **Singleton endpoint.** Its path has no unique component, so several
//!   workers can race to spawn it. [`DaemonListener::bind_singleton`] makes the
//!   race safe: the loser gets `AddrInUse` and exits quietly (see
//!   [`run_registry_daemon`]).
//! - **Idle exit.** A session daemon lives as long as its shell. The registry
//!   has nothing of its own to keep alive, so it exits once it has been empty
//!   for [`IDLE_TIMEOUT`] rather than lingering forever on a host whose desktops
//!   have all gone home. A worker that needs it again just respawns it.
//!
//! Liveness is the connection itself. A worker that exits — cleanly, killed, or
//! crashed — closes its socket, and the registry drops its record on EOF. There
//! is no PID reaping and no heartbeat, because there is nothing a dead worker
//! can leave behind.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::daemon::protocol::{read_frame_async_capped_timeout, write_frame_async};
use crate::daemon::transport::{registry_endpoint, BoxedReader, BoxedWriter, DaemonListener};
use crate::registry_daemon::protocol::{
    BroadcastEnvelope, ClientRecord, MSG_ACK, MSG_BROADCAST, MSG_CLIENTS, MSG_DEREGISTER,
    MSG_EVENT, MSG_LIST, MSG_REGISTER,
};

/// How long the registry stays up with no worker connected before exiting.
///
/// Long enough to ride out the gap while a host's last desktop reconnects (an
/// agent binary swap, an SSH blip) without a respawn; short enough that a host
/// nobody is using is not left with an idle process. Respawn is cheap and
/// automatic, so erring low costs only a process start.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(60);

/// Bound on a single worker's outbound queue.
///
/// The registry's outbound traffic is tiny and bursty: an `MSG_ACK`, the
/// occasional `MSG_CLIENTS` list, and the one production broadcast
/// (`agent.update_pending`, #1351). A healthy worker drains this instantly, so a
/// generous 256-frame queue never fills in normal operation. The cap exists only
/// to bound a *stalled* consumer: [`RegistryState::fan_out`] clones each
/// broadcast into every worker's queue, so a worker whose writer is blocked (slow
/// or wedged, not gone) would otherwise accumulate frames without limit. On a
/// full queue that worker is dropped rather than allowed to grow memory without
/// bound (see `fan_out`).
const REGISTRY_WORKER_QUEUE_CAP: usize = 256;

/// Per-connection frame ceiling for the registry reader.
///
/// Registry frames are a handful of small JSON records — a [`ClientRecord`], a
/// host-wide client list, or a [`BroadcastEnvelope`]. 64 KiB holds a client list
/// many hundreds of records deep, far more than any real host, while sitting a
/// factor of 256 below the session daemon's 16 MiB payload ceiling. The registry
/// accepts unbounded concurrent connections, so this small ceiling keeps a peer
/// from making it pre-allocate a large buffer per connection (N × 16 MiB would be
/// a cheap local memory-amplification). Enforced before allocation by
/// [`read_frame_async_capped_timeout`].
const REGISTRY_MAX_FRAME_BYTES: u32 = 64 * 1024;

/// Mid-frame read timeout for the registry reader.
///
/// Once a frame's first byte has arrived, the rest of that (tiny, local) frame
/// must arrive within this window; a peer that writes a partial header then
/// stalls (a local slowloris) is dropped rather than pinning its reader task and
/// `WorkerConn` forever. This is a *mid-frame* timeout only — a connected-but-idle
/// worker parked waiting for the next broadcast blocks before the first byte and
/// is never affected, so healthy idle workers are never reaped. A few seconds is
/// far longer than any real local frame takes yet bounds a wedged peer.
const REGISTRY_MID_FRAME_TIMEOUT: Duration = Duration::from_secs(5);

/// A single connected worker.
struct WorkerConn {
    /// The client this worker announced, once it has sent `MSG_REGISTER`.
    ///
    /// `None` between accept and register — and after a `MSG_DEREGISTER` from a
    /// worker whose client disconnected but whose process is still up. Such a
    /// worker still holds a live connection and still receives broadcasts; it
    /// just is not part of the client set.
    record: Option<ClientRecord>,
    /// Outbound frames for this worker, drained by its writer task. Bounded at
    /// [`REGISTRY_WORKER_QUEUE_CAP`] so a stalled consumer cannot grow memory
    /// without limit; a full queue reaps the worker (see [`RegistryState::fan_out`]).
    tx: mpsc::Sender<(u8, Vec<u8>)>,
}

/// The registry's whole state: who is connected, and how to reach them.
#[derive(Default)]
struct RegistryState {
    workers: Mutex<HashMap<u64, WorkerConn>>,
}

impl RegistryState {
    /// Snapshot of every registered client, host-wide.
    fn clients(&self) -> Vec<ClientRecord> {
        let guard = self.workers.lock().unwrap_or_else(|e| e.into_inner());
        guard.values().filter_map(|w| w.record.clone()).collect()
    }

    /// Number of live worker connections (registered or not).
    fn connection_count(&self) -> usize {
        let guard = self.workers.lock().unwrap_or_else(|e| e.into_inner());
        guard.len()
    }

    /// Fan `payload` out to every worker **connection** except `except_conn`.
    ///
    /// Deliberately keyed to the connection, not the client: an unregistered
    /// connection (mid `initialize`, or a client that deregistered but whose
    /// process is still up) is reached too. This is the intentional resolution
    /// of #1608, not an oversight — the fan-out targets connections while
    /// [`clients`](Self::clients) / `agent.list_connections` targets registered
    /// clients, and the two are meant to answer different questions:
    ///
    /// - A connection racing to register is *about to become a client*, and the
    ///   one production broadcast — `agent.update_pending` (#1351) — is precisely
    ///   the signal it must not miss, or it will spin up sessions the imminent
    ///   binary swap is about to tear down. Skipping it would open that race.
    /// - Reaching a connection with no client behind it is harmless: the worker
    ///   dispatches on frame type, never on ACK ordering (#1610), and a departed
    ///   client just drops the event on a closed channel (`client.rs`).
    ///
    /// A worker's queue is bounded ([`REGISTRY_WORKER_QUEUE_CAP`]), so this uses a
    /// non-blocking `try_send` and reaps any worker it cannot deliver to:
    ///
    /// - **`Full`** — the consumer is stalled (slow or wedged, not gone). Dropping
    ///   it is the safe policy: a broadcast must never block the whole fan-out on
    ///   one slow recipient, nor let that recipient's queue grow memory without
    ///   bound. The dropped worker's `WorkerConn` is removed here, which frees its
    ///   queued frames and stops its writer task; its reader loop unwinds when the
    ///   socket next errors or closes.
    /// - **`Closed`** — the receiving task is already gone; reap it now rather than
    ///   wait for its reader loop to notice.
    ///
    /// A broadcast must never fail because one recipient is slow or dead, so
    /// healthy workers are always delivered to regardless of what any other
    /// worker's queue is doing.
    fn fan_out(&self, except_conn: u64, msg_type: u8, payload: Vec<u8>) {
        let mut guard = self.workers.lock().unwrap_or_else(|e| e.into_inner());
        let mut wedged: Vec<u64> = Vec::new();
        for (conn_id, worker) in guard.iter() {
            if *conn_id == except_conn {
                continue;
            }
            match worker.tx.try_send((msg_type, payload.clone())) {
                Ok(()) => {}
                Err(mpsc::error::TrySendError::Full(_)) => {
                    warn!("Registry: worker {conn_id} outbound queue full, dropping slow worker");
                    wedged.push(*conn_id);
                }
                Err(mpsc::error::TrySendError::Closed(_)) => {
                    wedged.push(*conn_id);
                }
            }
        }
        for conn_id in wedged {
            guard.remove(&conn_id);
        }
    }
}

/// Run the registry daemon until it has been idle for [`IDLE_TIMEOUT`].
///
/// Binds the singleton endpoint first. If another registry already owns it the
/// bind fails with [`io::ErrorKind::AddrInUse`](std::io::ErrorKind::AddrInUse)
/// and this returns `Ok(())` — losing a spawn race is a **success**, not an
/// error: the winner is serving, which is exactly what the loser's spawner
/// wanted. Any other bind error is real and propagates.
pub async fn run_registry_daemon() -> anyhow::Result<()> {
    run_registry_daemon_at(&registry_endpoint(), IDLE_TIMEOUT).await
}

/// [`run_registry_daemon`] with the endpoint and idle timeout supplied.
///
/// Production always uses [`run_registry_daemon`]; this exists so tests can run
/// the **real** registry — real socket, real frames, real concurrency — on a
/// throwaway endpoint without racing the host's live one or waiting a minute to
/// observe the idle exit.
pub async fn run_registry_daemon_at(endpoint: &str, idle_timeout: Duration) -> anyhow::Result<()> {
    let mut listener = match DaemonListener::bind_singleton(endpoint).await {
        Ok(listener) => listener,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            info!("Registry daemon already running at {endpoint}, exiting");
            return Ok(());
        }
        Err(e) => {
            return Err(anyhow::anyhow!(
                "Failed to bind registry endpoint {endpoint}: {e}"
            ))
        }
    };

    info!("Registry daemon listening at {endpoint}");

    let state = Arc::new(RegistryState::default());
    let next_conn_id = AtomicU64::new(0);

    loop {
        match tokio::time::timeout(idle_timeout, listener.accept()).await {
            Ok(Ok((reader, writer))) => {
                let conn_id = next_conn_id.fetch_add(1, Ordering::Relaxed);
                tokio::spawn(serve_worker(state.clone(), conn_id, reader, writer));
            }
            Ok(Err(e)) => {
                // As in the TCP accept loop: a transient accept error must not
                // tear the registry down and disconnect every other worker.
                warn!("Registry accept() failed, continuing to listen: {e}");
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(_elapsed) => {
                if state.connection_count() == 0 {
                    info!("Registry daemon idle for {idle_timeout:?}, exiting");
                    break;
                }
            }
        }
    }

    listener.cleanup();
    Ok(())
}

/// Serve one worker connection for its whole life.
///
/// Splits into a writer task draining the worker's outbound queue and this
/// reader loop. On any read error or EOF the worker is removed from the state —
/// that removal is the registry's entire liveness story.
async fn serve_worker(
    state: Arc<RegistryState>,
    conn_id: u64,
    mut reader: BoxedReader,
    mut writer: BoxedWriter,
) {
    let (tx, mut rx) = mpsc::channel::<(u8, Vec<u8>)>(REGISTRY_WORKER_QUEUE_CAP);

    {
        let mut guard = state.workers.lock().unwrap_or_else(|e| e.into_inner());
        guard.insert(conn_id, WorkerConn { record: None, tx });
    }
    debug!("Registry: worker {conn_id} connected");

    let writer_task = tokio::spawn(async move {
        while let Some((msg_type, payload)) = rx.recv().await {
            if let Err(e) = write_frame_async(&mut writer, msg_type, &payload).await {
                debug!("Registry: write to worker failed, dropping writer: {e}");
                break;
            }
        }
    });

    loop {
        match read_frame_async_capped_timeout(
            &mut reader,
            REGISTRY_MAX_FRAME_BYTES,
            REGISTRY_MID_FRAME_TIMEOUT,
        )
        .await
        {
            Ok(Some(frame)) => handle_frame(&state, conn_id, frame),
            Ok(None) => {
                debug!("Registry: worker {conn_id} disconnected (EOF)");
                break;
            }
            Err(e) => {
                debug!("Registry: worker {conn_id} read error: {e}");
                break;
            }
        }
    }

    // The worker is gone — drop its record (and, by dropping its sender, stop
    // its writer task). This is what garbage-collects a crashed worker.
    {
        let mut guard = state.workers.lock().unwrap_or_else(|e| e.into_inner());
        guard.remove(&conn_id);
    }
    writer_task.abort();
}

/// Apply one frame from a worker to the registry state.
///
/// Never fails the connection on a bad frame: an unknown type or an undecodable
/// payload is logged and skipped. A worker built against a newer or older
/// vocabulary must degrade, not be disconnected — the registry outlives agent
/// binary swaps by design, so version skew across the endpoint is the normal
/// case, not an error.
fn handle_frame(state: &Arc<RegistryState>, conn_id: u64, frame: crate::daemon::protocol::Frame) {
    match frame.msg_type {
        MSG_REGISTER => {
            let record: ClientRecord = match serde_json::from_slice(&frame.payload) {
                Ok(record) => record,
                Err(e) => {
                    warn!("Registry: undecodable REGISTER from worker {conn_id}: {e}");
                    return;
                }
            };
            info!(
                "Registry: client {} ({} {}) registered from pid {}",
                record.client_id, record.client, record.client_version, record.pid
            );
            let mut guard = state.workers.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(worker) = guard.get_mut(&conn_id) {
                worker.record = Some(record);
                // Direct reply to this worker's own request; drop on a full queue
                // rather than block — a wedged worker is reaped by `fan_out`/EOF.
                let _ = worker.tx.try_send((MSG_ACK, Vec::new()));
            }
        }
        MSG_DEREGISTER => {
            let mut guard = state.workers.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(worker) = guard.get_mut(&conn_id) {
                if let Some(record) = worker.record.take() {
                    info!("Registry: client {} deregistered", record.client_id);
                }
            }
        }
        MSG_LIST => {
            let clients = state.clients();
            let payload = match serde_json::to_vec(&clients) {
                Ok(payload) => payload,
                Err(e) => {
                    warn!("Registry: failed to encode client list: {e}");
                    return;
                }
            };
            let guard = state.workers.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(worker) = guard.get(&conn_id) {
                let _ = worker.tx.try_send((MSG_CLIENTS, payload));
            }
        }
        MSG_BROADCAST => {
            // Decode only to validate and to log the origin — the payload is
            // forwarded byte-for-byte, so the registry never needs to
            // understand the notification it is carrying.
            match serde_json::from_slice::<BroadcastEnvelope>(&frame.payload) {
                Ok(envelope) => {
                    debug!(
                        "Registry: broadcasting {} from {}",
                        envelope.method, envelope.origin_client_id
                    );
                    state.fan_out(conn_id, MSG_EVENT, frame.payload);
                }
                Err(e) => warn!("Registry: undecodable BROADCAST from worker {conn_id}: {e}"),
            }
        }
        other => debug!("Registry: ignoring unknown frame type 0x{other:02x}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn record(client_id: &str) -> ClientRecord {
        ClientRecord {
            client_id: client_id.into(),
            client: "termihub-desktop".into(),
            client_version: "1.0.0".into(),
            connected_since: "2026-07-17T10:00:00+00:00".into(),
            pid: 1,
        }
    }

    fn conn(state: &RegistryState, conn_id: u64) -> mpsc::Receiver<(u8, Vec<u8>)> {
        let (tx, rx) = mpsc::channel(REGISTRY_WORKER_QUEUE_CAP);
        state
            .workers
            .lock()
            .unwrap()
            .insert(conn_id, WorkerConn { record: None, tx });
        rx
    }

    fn frame(msg_type: u8, payload: Vec<u8>) -> crate::daemon::protocol::Frame {
        crate::daemon::protocol::Frame { msg_type, payload }
    }

    #[test]
    fn register_records_the_client_and_acks() {
        let state = Arc::new(RegistryState::default());
        let mut rx = conn(&state, 0);

        handle_frame(
            &state,
            0,
            frame(MSG_REGISTER, serde_json::to_vec(&record("a")).unwrap()),
        );

        assert_eq!(state.clients(), vec![record("a")]);
        assert_eq!(rx.try_recv().expect("ack").0, MSG_ACK);
    }

    /// The property the whole issue turns on: a worker holding **no sessions**
    /// is still a registered, visible client. Registration is keyed to
    /// `initialize`, never to session topology.
    #[test]
    fn a_session_less_worker_is_still_visible_to_others() {
        let state = Arc::new(RegistryState::default());
        // Two workers, neither of which has ever mentioned a session.
        let _rx_a = conn(&state, 0);
        let mut rx_b = conn(&state, 1);
        handle_frame(
            &state,
            0,
            frame(MSG_REGISTER, serde_json::to_vec(&record("a")).unwrap()),
        );
        handle_frame(
            &state,
            1,
            frame(MSG_REGISTER, serde_json::to_vec(&record("b")).unwrap()),
        );

        // Worker B asks who is connected and sees session-less worker A.
        let _ = rx_b.try_recv(); // the ACK
        handle_frame(&state, 1, frame(MSG_LIST, Vec::new()));
        let (msg_type, payload) = rx_b.try_recv().expect("client list");
        assert_eq!(msg_type, MSG_CLIENTS);
        let clients: Vec<ClientRecord> = serde_json::from_slice(&payload).unwrap();

        let mut ids: Vec<String> = clients.into_iter().map(|c| c.client_id).collect();
        ids.sort();
        assert_eq!(ids, vec!["a", "b"]);
    }

    #[test]
    fn deregister_clears_the_record_but_keeps_the_connection() {
        let state = Arc::new(RegistryState::default());
        let _rx = conn(&state, 0);
        handle_frame(
            &state,
            0,
            frame(MSG_REGISTER, serde_json::to_vec(&record("a")).unwrap()),
        );
        handle_frame(&state, 0, frame(MSG_DEREGISTER, Vec::new()));

        assert!(state.clients().is_empty(), "record must be withdrawn");
        assert_eq!(
            state.connection_count(),
            1,
            "the worker is still connected and must keep receiving broadcasts"
        );
    }

    #[test]
    fn broadcast_reaches_every_other_worker_but_not_the_sender() {
        let state = Arc::new(RegistryState::default());
        let mut rx_a = conn(&state, 0);
        let mut rx_b = conn(&state, 1);
        let mut rx_c = conn(&state, 2);

        let envelope = BroadcastEnvelope {
            origin_client_id: "a".into(),
            method: "agent.update_pending".into(),
            params: json!({"version": "2.0.0"}),
        };
        handle_frame(
            &state,
            0,
            frame(MSG_BROADCAST, serde_json::to_vec(&envelope).unwrap()),
        );

        for rx in [&mut rx_b, &mut rx_c] {
            let (msg_type, payload) = rx.try_recv().expect("event delivered");
            assert_eq!(msg_type, MSG_EVENT);
            let got: BroadcastEnvelope = serde_json::from_slice(&payload).unwrap();
            assert_eq!(got, envelope);
        }
        assert!(
            rx_a.try_recv().is_err(),
            "a broadcast must not echo back to its sender"
        );
    }

    /// A connection that has opened but never sent `MSG_REGISTER` still receives
    /// broadcasts — and this is deliberate, not the oversight #1608 asked us to
    /// check. The fan-out targets **connections**, while `agent.list_connections`
    /// (via [`RegistryState::clients`]) targets registered **clients**: the two
    /// answer different questions and are meant to differ, not to agree.
    ///
    /// Why a not-yet-registered connection must still be reached: a worker mid
    /// `initialize` handshake is *racing to become a client*, and the one
    /// production broadcast — `agent.update_pending` (#1351) — is exactly the
    /// signal it must not miss, or it will spin up sessions the imminent binary
    /// swap is about to tear down. Delivery is harmless before registration: the
    /// worker dispatches on frame type (never on ACK ordering, see #1610) and a
    /// client that is not there yet simply drops the event on a closed channel.
    ///
    /// This test pins that behaviour so a later "tidy up the fan-out" change
    /// cannot silently drop the racing-registration case.
    #[test]
    fn an_unregistered_connection_still_receives_broadcasts() {
        let state = Arc::new(RegistryState::default());
        let _rx_sender = conn(&state, 0);
        let mut rx_unregistered = conn(&state, 1);
        // The sender registers; the recipient never does.
        handle_frame(
            &state,
            0,
            frame(MSG_REGISTER, serde_json::to_vec(&record("a")).unwrap()),
        );

        let envelope = BroadcastEnvelope {
            origin_client_id: "a".into(),
            method: "agent.update_pending".into(),
            params: json!({"version": "2.0.0"}),
        };
        handle_frame(
            &state,
            0,
            frame(MSG_BROADCAST, serde_json::to_vec(&envelope).unwrap()),
        );

        // The unregistered connection is invisible to `list`...
        assert_eq!(state.clients(), vec![record("a")]);
        // ...yet still receives the broadcast.
        let (msg_type, payload) = rx_unregistered
            .try_recv()
            .expect("event must reach an unregistered connection");
        assert_eq!(msg_type, MSG_EVENT);
        let got: BroadcastEnvelope = serde_json::from_slice(&payload).unwrap();
        assert_eq!(got, envelope);
    }

    /// A worker that registered and then sent `MSG_DEREGISTER` — its client
    /// disconnected but its process is still up and its socket still open — keeps
    /// receiving broadcasts, matching the invariant documented on [`WorkerConn`].
    /// Its record is gone from `list`, but the connection is live, so the fan-out
    /// still reaches it; with no client behind it the event harmlessly drops.
    #[test]
    fn a_deregistered_but_connected_worker_still_receives_broadcasts() {
        let state = Arc::new(RegistryState::default());
        let _rx_sender = conn(&state, 0);
        let mut rx_gone = conn(&state, 1);
        handle_frame(
            &state,
            0,
            frame(MSG_REGISTER, serde_json::to_vec(&record("a")).unwrap()),
        );
        handle_frame(
            &state,
            1,
            frame(MSG_REGISTER, serde_json::to_vec(&record("b")).unwrap()),
        );
        handle_frame(&state, 1, frame(MSG_DEREGISTER, Vec::new()));
        let _ = rx_gone.try_recv(); // drain b's ACK

        // b is no longer a client, but its connection is still live.
        assert_eq!(state.clients(), vec![record("a")]);
        assert_eq!(state.connection_count(), 2);

        let envelope = BroadcastEnvelope {
            origin_client_id: "a".into(),
            method: "agent.update_pending".into(),
            params: json!({"version": "2.0.0"}),
        };
        handle_frame(
            &state,
            0,
            frame(MSG_BROADCAST, serde_json::to_vec(&envelope).unwrap()),
        );

        let (msg_type, _) = rx_gone
            .try_recv()
            .expect("event must reach a deregistered-but-connected worker");
        assert_eq!(msg_type, MSG_EVENT);
    }

    /// A stalled consumer must not be able to grow memory without bound, nor stall
    /// delivery to healthy workers. When a worker's bounded outbound queue fills,
    /// the fan-out drops *that* worker (reaps its `WorkerConn`) and keeps
    /// delivering to everyone else — the broadcaster never blocks.
    #[test]
    fn a_full_worker_queue_drops_the_slow_worker_and_spares_healthy_ones() {
        let state = Arc::new(RegistryState::default());
        // Worker 0 never drains its queue (a stalled consumer).
        let _slow = conn(&state, 0);
        // Worker 1 drains one frame per round (a healthy consumer).
        let mut healthy = conn(&state, 1);

        let mut healthy_deliveries = 0usize;
        // Fan out more frames than a single worker's queue can hold.
        for _ in 0..(REGISTRY_WORKER_QUEUE_CAP + 5) {
            // `u64::MAX` is not a real connection, so nothing is excluded.
            state.fan_out(u64::MAX, MSG_EVENT, b"x".to_vec());
            if healthy.try_recv().is_ok() {
                healthy_deliveries += 1;
            }
        }

        let workers = state.workers.lock().unwrap();
        assert!(
            !workers.contains_key(&0),
            "the stalled worker must be reaped once its queue overflows"
        );
        assert!(
            workers.contains_key(&1),
            "the healthy worker must survive the slow peer"
        );
        assert!(
            healthy_deliveries >= REGISTRY_WORKER_QUEUE_CAP,
            "the healthy worker must keep receiving throughout ({healthy_deliveries} delivered)"
        );
    }

    #[test]
    fn a_malformed_frame_is_skipped_rather_than_failing_the_worker() {
        let state = Arc::new(RegistryState::default());
        let mut rx = conn(&state, 0);

        handle_frame(&state, 0, frame(MSG_REGISTER, b"not json".to_vec()));
        handle_frame(&state, 0, frame(0xEE, b"from a newer agent".to_vec()));
        // Still serving: a good REGISTER after the bad ones still works.
        handle_frame(
            &state,
            0,
            frame(MSG_REGISTER, serde_json::to_vec(&record("a")).unwrap()),
        );

        assert_eq!(state.clients(), vec![record("a")]);
        assert_eq!(rx.try_recv().expect("ack").0, MSG_ACK);
    }
}
