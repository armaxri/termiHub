//! Backend I/O outside the session-map lock (#4300, TAURI2-001 / CONC2-002).
//!
//! A backend `write` / `resize` is synchronous and can block for a long or
//! unbounded time: a PTY whose child stopped reading stdin, a telnet socket to
//! a peer that silently went away, an agent session waiting for queue credit.
//! Running it while holding the app-wide `sessions` lock froze input, resize,
//! list, create and close in **every** tab behind one stalled session.
//!
//! The manager therefore only *looks the session up* under the map lock: it
//! takes an [`IoHandle`] (a shared connection handle plus a read guard on the
//! session's I/O gate) and, for input, a ticket on the session's
//! [`InputLane`]; it drops the map lock and only then performs the blocking
//! call on the blocking thread pool.
//!
//! - **Per-session order.** Tickets are taken under the map lock, so input to
//!   one session is written in exactly the order the map lock was acquired —
//!   the same order the old map-wide lock enforced.
//! - **Close never races into a removed session.** Close removes the entry
//!   under the map lock, so no new handle can be taken; it then takes the I/O
//!   gate's write half, which waits only for handles already in flight, and
//!   disconnects with exclusive access. When a write is stuck, close does not
//!   wait for it: it interrupts the backend's in-flight I/O
//!   ([`ConnectionType::interrupt_io`], #4394) so the write returns promptly,
//!   and the disconnect is deferred to a background task that runs once it has.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use termihub_core::connection::ConnectionType;
use termihub_core::session::pump::OutputFlowGate;
use tokio::sync::{watch, OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};
use tracing::{info, warn};

/// A session's I/O coordination state, held on its entry.
#[derive(Default)]
pub(in crate::session) struct SessionIo {
    /// Read-held by every in-flight [`IoHandle`]; write-held by teardown.
    gate: Arc<RwLock<()>>,
    /// Orders the session's input writes.
    lane: Arc<InputLane>,
    /// The frontend's output pause/resume switch (PERF2-002). Only wired into
    /// the output reader for sessions whose producer blocks on a full channel;
    /// for the rest (agent-proxied sessions) flipping it has no effect.
    output_flow: OutputFlowGate,
}

impl SessionIo {
    /// Take an I/O handle on `connection`. `None` once teardown holds the gate
    /// (the session is being closed), which callers report as "session gone".
    pub(in crate::session) fn handle(
        &self,
        connection: &Arc<dyn ConnectionType>,
    ) -> Option<IoHandle> {
        let gate = self.gate.clone().try_read_owned().ok()?;
        Some(IoHandle {
            connection: connection.clone(),
            _gate: gate,
        })
    }

    /// The session's output flow gate (a shared handle).
    pub(super) fn output_flow(&self) -> OutputFlowGate {
        self.output_flow.clone()
    }

    /// Take the next input ticket for this session, with its lane.
    pub(super) fn ticket(&self) -> (Arc<InputLane>, u64) {
        let ticket = self.lane.next.fetch_add(1, Ordering::SeqCst);
        (self.lane.clone(), ticket)
    }
}

/// A shared connection handle usable outside the session-map lock.
///
/// Taken for blocking writes / resizes and for file-browser calls
/// ([`FileOps`](crate::session::file_ops), #4393), so a slow SFTP / FTP /
/// `docker exec` / agent round-trip neither holds the map lock nor outlives
/// the connection: close waits for (and defers its disconnect behind) every
/// handle still in flight.
///
/// Field order matters: the connection clone drops before the gate guard, so
/// once teardown acquires the gate no in-flight handle still shares the
/// connection.
pub(in crate::session) struct IoHandle {
    pub(in crate::session) connection: Arc<dyn ConnectionType>,
    _gate: OwnedRwLockReadGuard<()>,
}

/// FIFO ordering of one session's input writes, by ticket.
pub(super) struct InputLane {
    /// The next ticket to hand out.
    next: AtomicU64,
    /// The ticket whose turn it is.
    turn: watch::Sender<u64>,
}

impl Default for InputLane {
    fn default() -> Self {
        Self {
            next: AtomicU64::new(0),
            turn: watch::Sender::new(0),
        }
    }
}

impl InputLane {
    /// Wait until `ticket` is served; the returned guard passes the turn on
    /// when dropped. Every ticket handed out must be awaited exactly once, or
    /// later tickets never get their turn.
    pub(super) async fn wait_turn(self: Arc<Self>, ticket: u64) -> TurnGuard {
        let mut turn = self.turn.subscribe();
        // The lane owns the sender, so the wait cannot observe it closing.
        let _ = turn.wait_for(|served| *served == ticket).await;
        TurnGuard(self)
    }
}

/// Passes the input turn to the next ticket on drop (including on panic).
pub(super) struct TurnGuard(Arc<InputLane>);

impl Drop for TurnGuard {
    fn drop(&mut self) {
        self.0.turn.send_modify(|served| *served += 1);
    }
}

/// Disconnect a connection removed from the session map.
///
/// Disconnects inline when no I/O is in flight. Otherwise a blocked write or
/// resize still shares the connection, and `disconnect` needs exclusive access,
/// so it is deferred to a background task that runs once the in-flight I/O
/// returns — the caller (a tab close) is not held up by the stalled session.
///
/// A write can stay blocked indefinitely (a PTY whose program never reads
/// stdin again, a telnet peer that stopped reading), which would leave the
/// child process or socket behind the closed tab. So before deferring, the
/// backend is told to interrupt that I/O ([`ConnectionType::interrupt_io`]:
/// the local shell kills its child, telnet shuts its socket down), and the
/// deferred disconnect follows as soon as the write fails (#4394).
pub(super) async fn disconnect_removed(
    session_id: &str,
    connection: Arc<dyn ConnectionType>,
    io: SessionIo,
) {
    match io.gate.clone().try_write_owned() {
        Ok(gate) => disconnect_exclusive(session_id, connection, gate).await,
        Err(_) => {
            info!(
                session_id,
                "Backend I/O still in flight; interrupting it, disconnect deferred until it returns"
            );
            connection.interrupt_io();
            let session_id = session_id.to_string();
            tokio::spawn(async move {
                let gate = io.gate.clone().write_owned().await;
                disconnect_exclusive(&session_id, connection, gate).await;
            });
        }
    }
}

async fn disconnect_exclusive(
    session_id: &str,
    mut connection: Arc<dyn ConnectionType>,
    _gate: OwnedRwLockWriteGuard<()>,
) {
    match Arc::get_mut(&mut connection) {
        Some(connection) => {
            connection.disconnect().await.ok();
        }
        // Not reachable while every shared clone is an `IoHandle`: holding the
        // gate's write half means none is left. Dropping still releases the
        // backend through its `Drop` once the last clone goes.
        None => warn!(
            session_id,
            "Connection still shared at close; dropped without disconnect"
        ),
    }
}
