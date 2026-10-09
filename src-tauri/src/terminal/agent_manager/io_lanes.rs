//! Bounded, backpressured command path into the agent I/O task (#3018,
//! deferred from TAURI-014).
//!
//! # Shape
//!
//! Every producer still enqueues [`AgentIoCommand`]s into one FIFO ingress
//! channel, but the **data** those commands carry is bounded by a per-agent
//! byte-credit budget ([`IoBudget`]) instead of by the channel type:
//!
//! * **Gated data** — [`SessionInput`](AgentIoCommand::SessionInput) and
//!   [`AgentForwardData`](AgentIoCommand::AgentForwardData) — acquire
//!   [`data_cost`] credits *before* they are enqueued and hand them back only
//!   once the I/O task has written them to the agent (or deliberately dropped
//!   them). A producer that finds the budget exhausted **waits** (backpressure);
//!   nothing is dropped for being "full". So all queued payload for one agent —
//!   in the ingress, in the task's data lane, and the one write in flight —
//!   never exceeds [`AGENT_IO_DATA_BUDGET`].
//! * **Ungated data** — [`SessionResize`](AgentIoCommand::SessionResize) and
//!   [`AgentForwardClose`](AgentIoCommand::AgentForwardClose) — ride the data
//!   lane so they stay ordered with the input / stream bytes around them (a
//!   stream's close must follow its last bytes), but never wait for credit: they
//!   are fixed-size, human- or once-per-stream-rate, and a close must never be
//!   blocked by a full budget.
//! * **Control** — everything else (requests, output flow control,
//!   (un)registrations, keyboard-interactive answers, `Disconnect`, the test
//!   sever) — is never gated and is
//!   served **ahead of** queued data: [`IoLanes::next_command`] moves data out of
//!   the ingress into its own lane as it arrives, so a control command behind a
//!   full data backlog is reached after at most the one write already in flight.
//!   That write is itself bounded: terminal input is split into
//!   [`AGENT_IO_MAX_CHUNK`] pieces at the producer.
//!
//! # Why the ingress stays an unbounded channel
//!
//! The self-requeue deadlock the issue describes is structural to a bounded
//! channel: the I/O task is the sole drainer and it re-queues reconnect
//! survivors into its own ingress. Bounding *credits* instead of *slots* removes
//! that hazard — the I/O task never acquires credit (survivors keep the credit
//! they were admitted with), so it can never block on its own queue — while the
//! producers still cannot grow memory without bound. Control commands are not
//! credit-bounded, but each has a naturally bounded producer (a request awaits
//! its response; registrations are one per session/stream/run).
//!
//! # Deadlock freedom
//!
//! * The I/O task never waits on the budget.
//! * Waiters never hold the agent map lock (the manager snapshots the sender
//!   first) and give up promptly when the budget closes (the task ended: a
//!   `Disconnect`, an abort, an exhausted reconnect — [`CloseBudgetOnDrop`]) or
//!   when the transport starts reconnecting (the task stops draining for the
//!   outage; [`IoBudget::interrupt`] wakes them to see the flag). No waiter uses
//!   a timer, so the gate behaves identically under a paused test clock.
//! * A synchronous waiter on a multi-threaded runtime worker parks inside
//!   `block_in_place`, so waiting can never starve the runtime of the thread the
//!   I/O task needs; on a current-thread runtime (never used by the app) it
//!   refuses to wait rather than deadlock.
//!
//! # Ordering
//!
//! Data is served strictly FIFO, and credit is granted FIFO among waiters
//! (tickets), so one session's input — written by a single serialized producer —
//! is never reordered, and a large chunk is never starved by smaller ones.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::task::Poll;

use tokio::sync::mpsc::error::TryRecvError;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tokio::sync::Notify;

use super::io_task::filter_reconnect_backlog;
use super::AgentIoCommand;

/// Per-agent budget for queued, not-yet-written data (payload plus
/// [`AGENT_IO_ITEM_OVERHEAD`] per command), in bytes.
///
/// 1 MiB keeps a large paste or a graphical port-forward streaming at link
/// speed — sixteen [`AGENT_IO_MAX_CHUNK`]s are queued ahead of the single
/// sequential writer, so it never idles waiting for a producer round-trip —
/// while capping one agent's worst-case backlog at ~1 MiB of payload and ~4k
/// commands (a flood of one-byte keystrokes). A deeper queue would buy no
/// throughput (the writer drains one command at a time into the SSH channel's
/// own flow-control window) and only add memory and input latency.
pub(crate) const AGENT_IO_DATA_BUDGET: usize = 1024 * 1024;

/// Largest terminal-input write enqueued as one command. Bounds how long a
/// control command can wait behind the write in flight, and keeps one paste
/// from needing the whole budget at once. Matches the port-forward read chunk.
pub(crate) const AGENT_IO_MAX_CHUNK: usize = 64 * 1024;

/// Fixed per-command cost added to the payload, so a flood of tiny writes is
/// bounded in command count, not just in bytes (each queued command carries a
/// session/stream id and allocation overhead).
pub(crate) const AGENT_IO_ITEM_OVERHEAD: usize = 256;

/// Which lane of the I/O task a command travels in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Lane {
    /// Served ahead of queued data; never gated.
    Control,
    /// Served FIFO with the other data; gated when the cost is non-zero.
    Data { cost: usize },
}

/// Classify a command. Exhaustive on purpose: a new variant must pick a lane.
pub(crate) fn lane_of(cmd: &AgentIoCommand) -> Lane {
    match cmd {
        AgentIoCommand::SessionInput { session_id, data } => Lane::Data {
            cost: data_item_cost(session_id, data),
        },
        AgentIoCommand::AgentForwardData { stream_id, data } => Lane::Data {
            cost: data_item_cost(stream_id, data),
        },
        AgentIoCommand::SessionResize { .. } | AgentIoCommand::AgentForwardClose { .. } => {
            Lane::Data { cost: 0 }
        }
        // A pause must never wait behind a queued paste, and a resume never
        // behind anything: flow control rides the control lane, FIFO with the
        // other control commands so pause/resume keep their order (#4416). A
        // forward ack (#4284) likewise: it frees the agent's side of a stream,
        // so it must not wait behind data that may itself be waiting on it.
        AgentIoCommand::Request { .. }
        | AgentIoCommand::SessionOutputFlow { .. }
        | AgentIoCommand::AgentForwardAck { .. }
        | AgentIoCommand::RegisterSession { .. }
        | AgentIoCommand::UnregisterSession { .. }
        | AgentIoCommand::RegisterFilesOnly { .. }
        | AgentIoCommand::RegisterMonitoring { .. }
        | AgentIoCommand::RegisterMonitoringStatus { .. }
        | AgentIoCommand::UnregisterMonitoring { .. }
        | AgentIoCommand::RegisterToolRun { .. }
        | AgentIoCommand::UnregisterToolRun { .. }
        | AgentIoCommand::RegisterForwardStream { .. }
        | AgentIoCommand::UnregisterForwardStream { .. }
        | AgentIoCommand::KiRespond { .. }
        | AgentIoCommand::ReadUpdateAuthToken { .. }
        | AgentIoCommand::Disconnect
        | AgentIoCommand::TestSeverTransport => Lane::Control,
    }
}

/// Credit a command holds while queued (`0` for control and ungated data).
pub(crate) fn data_cost(cmd: &AgentIoCommand) -> usize {
    match lane_of(cmd) {
        Lane::Data { cost } => cost,
        Lane::Control => 0,
    }
}

fn data_item_cost(id: &str, data: &[u8]) -> usize {
    data.len()
        .saturating_add(id.len())
        .saturating_add(AGENT_IO_ITEM_OVERHEAD)
}

/// Why a gated send did not enqueue its command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GateError {
    /// The I/O task is gone (budget closed or ingress closed).
    Closed,
    /// The budget is full and the transport is reconnecting: the task will not
    /// drain until the outage resolves, so the send gives up instead of parking
    /// its caller for the whole reconnect window.
    Reconnecting,
    /// The budget is full and the caller is on a current-thread runtime, where
    /// blocking would stall the very executor that drains the queue.
    WouldDeadlock,
}

#[derive(Debug)]
struct BudgetState {
    available: usize,
    closed: bool,
    /// FIFO of waiting tickets; only the head may take credit.
    queue: VecDeque<u64>,
    next_ticket: u64,
}

/// A per-agent byte-credit budget with FIFO admission, usable from both
/// synchronous and asynchronous producers. See the module docs.
#[derive(Debug)]
pub(crate) struct IoBudget {
    capacity: usize,
    state: Mutex<BudgetState>,
    cond: Condvar,
    notify: Notify,
}

impl IoBudget {
    /// A budget of `capacity` credits (at least 1).
    pub(crate) fn new(capacity: usize) -> Arc<Self> {
        let capacity = capacity.max(1);
        Arc::new(Self {
            capacity,
            state: Mutex::new(BudgetState {
                available: capacity,
                closed: false,
                queue: VecDeque::new(),
                next_ticket: 0,
            }),
            cond: Condvar::new(),
            notify: Notify::new(),
        })
    }

    /// Total credits.
    #[cfg(test)]
    pub(crate) fn capacity(&self) -> usize {
        self.capacity
    }

    /// Credits currently held by queued or in-flight data.
    #[cfg(test)]
    pub(crate) fn in_use(&self) -> usize {
        self.capacity - self.lock().available
    }

    /// Whether the owning I/O task has ended.
    #[cfg(test)]
    pub(crate) fn is_closed(&self) -> bool {
        self.lock().closed
    }

    /// Number of producers currently waiting for credit.
    #[cfg(test)]
    pub(crate) fn waiters(&self) -> usize {
        self.lock().queue.len()
    }

    /// An oversize item is admitted alone (it takes the whole budget), so it
    /// can always make progress.
    fn clamp(&self, cost: usize) -> usize {
        cost.min(self.capacity)
    }

    fn lock(&self) -> MutexGuard<'_, BudgetState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn wake_all(&self) {
        self.cond.notify_all();
        self.notify.notify_waiters();
    }

    /// One admission attempt under the lock. `ticket` is this waiter's place in
    /// line (assigned on its first unsuccessful attempt).
    fn poll_admit(
        &self,
        st: &mut BudgetState,
        ticket: &mut Option<u64>,
        cost: usize,
        reconnecting: &AtomicBool,
    ) -> Poll<Result<(), GateError>> {
        if st.closed {
            Self::leave_queue(st, ticket);
            return Poll::Ready(Err(GateError::Closed));
        }
        let at_head = match *ticket {
            None => st.queue.is_empty(),
            Some(t) => st.queue.front() == Some(&t),
        };
        if at_head && st.available >= cost {
            st.available -= cost;
            if ticket.take().is_some() {
                st.queue.pop_front();
            }
            return Poll::Ready(Ok(()));
        }
        if reconnecting.load(Ordering::SeqCst) {
            Self::leave_queue(st, ticket);
            return Poll::Ready(Err(GateError::Reconnecting));
        }
        if ticket.is_none() {
            let t = st.next_ticket;
            st.next_ticket = st.next_ticket.wrapping_add(1);
            st.queue.push_back(t);
            *ticket = Some(t);
        }
        Poll::Pending
    }

    fn leave_queue(st: &mut BudgetState, ticket: &mut Option<u64>) {
        if let Some(t) = ticket.take() {
            st.queue.retain(|q| *q != t);
        }
    }

    /// Acquire `cost` credits, waiting (asynchronously) for the I/O task to
    /// free them. Cancel-safe: dropping the future gives up its place in line.
    pub(crate) async fn acquire(
        &self,
        cost: usize,
        reconnecting: &AtomicBool,
    ) -> Result<(), GateError> {
        let cost = self.clamp(cost);
        let mut waiter = Waiter {
            budget: self,
            ticket: None,
        };
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            // Register for a wake-up *before* checking, so a release or
            // interrupt between the check and the await is never lost.
            notified.as_mut().enable();
            {
                let mut st = self.lock();
                if let Poll::Ready(result) =
                    self.poll_admit(&mut st, &mut waiter.ticket, cost, reconnecting)
                {
                    drop(st);
                    // The head moved (or we left the line): let the next waiter look.
                    self.wake_all();
                    return result;
                }
            }
            notified.await;
        }
    }

    /// Acquire `cost` credits from synchronous code, blocking the thread until
    /// the I/O task frees them. On a multi-threaded runtime worker the wait runs
    /// inside `block_in_place`; on a current-thread runtime it fails with
    /// [`GateError::WouldDeadlock`] instead of blocking.
    pub(crate) fn acquire_blocking(
        &self,
        cost: usize,
        reconnecting: &AtomicBool,
    ) -> Result<(), GateError> {
        let cost = self.clamp(cost);
        let mut waiter = Waiter {
            budget: self,
            ticket: None,
        };
        {
            let mut st = self.lock();
            if let Poll::Ready(result) =
                self.poll_admit(&mut st, &mut waiter.ticket, cost, reconnecting)
            {
                drop(st);
                self.wake_all();
                return result;
            }
        }
        let wait = |waiter: &mut Waiter<'_>| {
            let mut st = self.lock();
            loop {
                if let Poll::Ready(result) =
                    self.poll_admit(&mut st, &mut waiter.ticket, cost, reconnecting)
                {
                    drop(st);
                    self.wake_all();
                    return result;
                }
                st = self.cond.wait(st).unwrap_or_else(|e| e.into_inner());
            }
        };
        match tokio::runtime::Handle::try_current() {
            Ok(handle)
                if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::CurrentThread =>
            {
                // `waiter` drops here and gives up its ticket.
                Err(GateError::WouldDeadlock)
            }
            Ok(_) => tokio::task::block_in_place(|| wait(&mut waiter)),
            Err(_) => wait(&mut waiter),
        }
    }

    /// Return `cost` credits (the item was written or deliberately dropped).
    pub(crate) fn release(&self, cost: usize) {
        let cost = self.clamp(cost);
        if cost == 0 {
            return;
        }
        {
            let mut st = self.lock();
            st.available = (st.available + cost).min(self.capacity);
        }
        self.wake_all();
    }

    /// Wake every waiter so it re-checks the reconnecting flag. The I/O task
    /// calls this right after setting the flag on a transport break.
    pub(crate) fn interrupt(&self) {
        // Taking the lock orders this after any waiter's check-then-wait, so a
        // condvar waiter cannot miss the wake-up.
        drop(self.lock());
        self.wake_all();
    }

    /// The I/O task ended: fail every current and future waiter.
    pub(crate) fn close(&self) {
        self.lock().closed = true;
        self.wake_all();
    }
}

/// A waiter's place in line; leaving the line on drop (a cancelled async
/// acquire, or a refused blocking one) lets the next waiter proceed.
struct Waiter<'a> {
    budget: &'a IoBudget,
    ticket: Option<u64>,
}

impl Drop for Waiter<'_> {
    fn drop(&mut self) {
        if self.ticket.is_some() {
            {
                let mut st = self.budget.lock();
                IoBudget::leave_queue(&mut st, &mut self.ticket);
            }
            self.budget.wake_all();
        }
    }
}

/// Closes the budget when the I/O task ends by any path — return, panic or
/// abort — so no producer waits forever for credit that will never come back.
pub(crate) struct CloseBudgetOnDrop(pub(crate) Arc<IoBudget>);

impl Drop for CloseBudgetOnDrop {
    fn drop(&mut self) {
        self.0.close();
    }
}

/// Credit held by a data command the I/O task is serving; returned on drop,
/// i.e. after the write completed (or the task bailed out of it).
pub(crate) struct DataCredit {
    budget: Arc<IoBudget>,
    cost: usize,
}

impl Drop for DataCredit {
    fn drop(&mut self) {
        self.budget.release(self.cost);
    }
}

/// A producer's handle on one agent's I/O task: the ingress sender plus the
/// budget and reconnecting flag that gate it.
#[derive(Clone)]
pub(crate) struct AgentIoSender {
    tx: UnboundedSender<AgentIoCommand>,
    budget: Arc<IoBudget>,
    reconnecting: Arc<AtomicBool>,
}

impl AgentIoSender {
    pub(crate) fn new(
        tx: UnboundedSender<AgentIoCommand>,
        budget: Arc<IoBudget>,
        reconnecting: Arc<AtomicBool>,
    ) -> Self {
        Self {
            tx,
            budget,
            reconnecting,
        }
    }

    /// Whether the transport is currently reconnecting.
    pub(crate) fn is_reconnecting(&self) -> bool {
        self.reconnecting.load(Ordering::SeqCst)
    }

    /// Enqueue `cmd`, first awaiting credit if it is gated data.
    pub(crate) async fn send(&self, cmd: AgentIoCommand) -> Result<(), GateError> {
        let cost = data_cost(&cmd);
        if cost > 0 {
            self.budget.acquire(cost, &self.reconnecting).await?;
        }
        self.enqueue(cmd, cost)
    }

    /// Enqueue `cmd` from synchronous code, first blocking for credit if it is
    /// gated data (see [`IoBudget::acquire_blocking`]).
    pub(crate) fn send_blocking(&self, cmd: AgentIoCommand) -> Result<(), GateError> {
        let cost = data_cost(&cmd);
        if cost > 0 {
            self.budget.acquire_blocking(cost, &self.reconnecting)?;
        }
        self.enqueue(cmd, cost)
    }

    fn enqueue(&self, cmd: AgentIoCommand, cost: usize) -> Result<(), GateError> {
        self.tx.send(cmd).map_err(|_| {
            // Never queued, so hand the credit straight back.
            self.budget.release(cost);
            GateError::Closed
        })
    }
}

/// Test-only: wrap a bare sender with its own (never-drained) budget, for
/// tests that drive a relay without a real I/O task.
#[cfg(test)]
impl From<UnboundedSender<AgentIoCommand>> for AgentIoSender {
    fn from(tx: UnboundedSender<AgentIoCommand>) -> Self {
        Self::new(
            tx,
            IoBudget::new(AGENT_IO_DATA_BUDGET),
            Arc::new(AtomicBool::new(false)),
        )
    }
}

/// What the I/O task should serve next.
pub(crate) enum Next {
    /// A control command, served ahead of any queued data.
    Control(AgentIoCommand),
    /// The oldest queued data command, with the credit it returns once served.
    Data(AgentIoCommand, DataCredit),
    /// Every sender is gone and no data is left.
    Closed,
}

/// The I/O task's receive side: the ingress plus the data lane control
/// commands overtake.
pub(crate) struct IoLanes {
    rx: UnboundedReceiver<AgentIoCommand>,
    data: VecDeque<(AgentIoCommand, usize)>,
    budget: Arc<IoBudget>,
}

impl IoLanes {
    pub(crate) fn new(rx: UnboundedReceiver<AgentIoCommand>, budget: Arc<IoBudget>) -> Self {
        Self {
            rx,
            data: VecDeque::new(),
            budget,
        }
    }

    /// Number of data commands waiting in the lane (excluding the ingress).
    #[cfg(test)]
    pub(crate) fn queued_data(&self) -> usize {
        self.data.len()
    }

    /// Every command not yet served: the data lane plus the ingress.
    #[cfg(test)]
    pub(crate) fn backlog(&self) -> usize {
        self.data.len() + self.rx.len()
    }

    fn route(&mut self, cmd: AgentIoCommand) -> Option<AgentIoCommand> {
        match lane_of(&cmd) {
            Lane::Control => Some(cmd),
            Lane::Data { cost } => {
                self.data.push_back((cmd, cost));
                None
            }
        }
    }

    fn pop_data(&mut self) -> Option<Next> {
        self.data.pop_front().map(|(cmd, cost)| {
            Next::Data(
                cmd,
                DataCredit {
                    budget: self.budget.clone(),
                    cost,
                },
            )
        })
    }

    /// The next command to serve: any control command already received (the
    /// ingress is drained into the data lane to find it), else the oldest data
    /// command, else the next arrival.
    ///
    /// Cancel-safe (the I/O task `select!`s it against the SSH channel): the only
    /// suspension point is the ingress `recv`, and anything received before it is
    /// already parked in the data lane.
    pub(crate) async fn next_command(&mut self) -> Next {
        loop {
            match self.rx.try_recv() {
                Ok(cmd) => {
                    if let Some(control) = self.route(cmd) {
                        return Next::Control(control);
                    }
                    continue;
                }
                Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => {}
            }
            if let Some(next) = self.pop_data() {
                return next;
            }
            match self.rx.recv().await {
                Some(cmd) => {
                    if let Some(control) = self.route(cmd) {
                        return Next::Control(control);
                    }
                }
                None => return Next::Closed,
            }
        }
    }

    /// Collect the post-reconnect backlog (CONC-014): the queued data lane plus
    /// everything still in the ingress, in arrival order, filtered by
    /// [`filter_reconnect_backlog`]. Credits of the commands the filter drops are
    /// released here; survivors keep theirs until they are served, so the
    /// caller re-queues them through the ingress **without** acquiring credit —
    /// the I/O task never waits on its own budget.
    pub(crate) fn drain_reconnect_backlog(&mut self) -> Vec<AgentIoCommand> {
        let mut drained: Vec<AgentIoCommand> = self.data.drain(..).map(|(cmd, _)| cmd).collect();
        while let Ok(cmd) = self.rx.try_recv() {
            drained.push(cmd);
        }
        let held: usize = drained
            .iter()
            .map(|c| self.budget.clamp(data_cost(c)))
            .sum();
        let kept = filter_reconnect_backlog(drained);
        let kept_cost: usize = kept.iter().map(|c| self.budget.clamp(data_cost(c))).sum();
        // `release` clamps per call, so return the difference in capacity-sized
        // steps to keep the arithmetic exact for oversize items.
        let mut freed = held.saturating_sub(kept_cost);
        while freed > 0 {
            let step = freed.min(self.budget.capacity);
            self.budget.release(step);
            freed -= step;
        }
        kept
    }
}

#[cfg(test)]
#[path = "io_lanes_tests.rs"]
mod tests;
