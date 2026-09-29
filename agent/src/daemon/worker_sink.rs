//! Bounded, deadline-guarded writes from the session daemon to its attached
//! worker (#3890).
//!
//! The daemon's event loop used to write every frame to the worker inline, with
//! no timeout. A worker that stopped reading while the shell kept producing
//! output filled the socket buffer, the next write blocked forever, and with it
//! the whole loop: no takeover, no other worker, not even the heartbeat reap
//! (#3140) of that very worker.
//!
//! A [`WorkerSink`] moves those writes onto a dedicated writer task, so the
//! event loop only ever *enqueues*:
//!
//! - **Ordering.** One FIFO queue per connection, drained by one task, so frames
//!   reach the worker in exactly the order the loop produced them.
//! - **Progress deadline.** Every socket write must accept at least one byte
//!   within [`WRITE_STALL_TIMEOUT`]. A worker that stops reading is detected
//!   within that bound and the task ends with [`io::ErrorKind::TimedOut`]; the
//!   loop sees [`SinkEvent::Finished`] and drops the worker exactly as it does
//!   for any other write error. The deadline is on *progress*, not on a whole
//!   frame, so a slow but reading worker is never dropped, however large the
//!   frame (a 16 MiB buffer replay) and however long it takes.
//! - **Byte budget, not loss.** The loop stops *forwarding* output while more
//!   than [`OUTBOUND_BUDGET_BYTES`] are queued ([`WorkerSink::has_room`]) and
//!   resumes on [`SinkEvent::Room`]. Nothing is dropped: the backlog waits in the
//!   output channel, which is ordinary terminal flow control for a worker that
//!   is merely slow. The pause is bounded, because a worker that makes no
//!   progress at all is dropped at the stall deadline, after which output flows
//!   into the ring buffer unattached and is replayed on the next attach.

use std::io;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, Notify};
use tokio::task::JoinHandle;
use tracing::debug;

use super::protocol;
use super::transport::BoxedWriter;

/// Longest a single socket write may go without the worker accepting a byte
/// before the worker is declared not-reading and dropped.
///
/// Equal to [`protocol::SESSION_MID_FRAME_TIMEOUT`], the read side's bound on a
/// peer that stops making progress mid-frame, so a wedged peer is caught in the
/// same time whichever direction it wedged in. Both peers share one host over a
/// local socket, where a reading worker drains a full socket buffer in well
/// under a millisecond; 30 s without a single byte accepted only happens to a
/// worker that has stopped reading (hung, stopped, deadlocked), never to a busy
/// or swapping one, whose scheduler stalls are seconds. The bound is on
/// progress, so it never scales with frame size or queue depth.
pub const WRITE_STALL_TIMEOUT: Duration = protocol::SESSION_MID_FRAME_TIMEOUT;

/// Queued bytes above which the loop pauses output forwarding until the worker
/// catches up.
///
/// 1 MiB, the default ring buffer size: enough to absorb a burst of output
/// while the worker is briefly descheduled, without holding more than one
/// buffer's worth of copies per session. Reaching it is flow control, not a
/// fault: the worker is never dropped for it and no output is lost. Only frames
/// the loop forwards on its own initiative (output, and file / monitoring /
/// process replies) are gated; handshake and heartbeat frames are always
/// admitted, so the queue can overshoot the budget by one gated frame plus
/// those, e.g. a buffer replay.
pub const OUTBOUND_BUDGET_BYTES: usize = termihub_core::buffer::DEFAULT_BUFFER_CAPACITY;

/// What the writer task has to report to the loop.
#[derive(Debug)]
pub enum SinkEvent {
    /// The queue fell back under [`OUTBOUND_BUDGET_BYTES`]: forwarding may
    /// resume.
    Room,
    /// The writer task ended: the worker stopped reading
    /// ([`io::ErrorKind::TimedOut`]) or its socket failed. Drop the worker.
    Finished(io::Result<()>),
}

/// State shared between a [`WorkerSink`] and its writer task.
#[derive(Debug, Default)]
struct Budget {
    /// Encoded bytes enqueued but not yet written.
    queued: AtomicUsize,
    /// Signalled whenever a frame has been written.
    drained: Notify,
}

/// The daemon's handle on one attached worker's outbound frames.
///
/// Dropping the sink aborts its writer task, which closes the socket at once
/// (detach, disconnect); [`close`](Self::close) instead lets queued frames
/// drain for a bounded time first (eviction, session exit).
#[derive(Debug)]
pub struct WorkerSink {
    tx: mpsc::UnboundedSender<Vec<u8>>,
    budget: Arc<Budget>,
    task: Option<JoinHandle<io::Result<()>>>,
}

impl WorkerSink {
    /// Start the writer task for `writer`.
    pub fn spawn(writer: BoxedWriter) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let budget = Arc::new(Budget::default());
        let task = tokio::spawn(run_writer(writer, rx, Arc::clone(&budget)));
        Self {
            tx,
            budget,
            task: Some(task),
        }
    }

    /// Whether the loop may forward more output now (the queue is under
    /// [`OUTBOUND_BUDGET_BYTES`]).
    pub fn has_room(&self) -> bool {
        self.budget.queued.load(Ordering::Acquire) < OUTBOUND_BUDGET_BYTES
    }

    /// Enqueue one frame. Never blocks. A frame for a writer task that has
    /// already ended is discarded; the loop learns of the end through
    /// [`next_event`](Self::next_event).
    pub fn send(&self, msg_type: u8, payload: &[u8]) {
        let frame = protocol::encode_frame(msg_type, payload);
        let len = frame.len();
        self.budget.queued.fetch_add(len, Ordering::AcqRel);
        if self.tx.send(frame).is_err() {
            self.budget.queued.fetch_sub(len, Ordering::AcqRel);
            debug!("Dropping frame 0x{msg_type:02x} for a worker whose writer has ended");
        }
    }

    /// Wait for the next thing the loop must act on: the writer task ending,
    /// or — only while the loop is paused on the budget — room freeing up.
    pub async fn next_event(&mut self) -> SinkEvent {
        let paused = !self.has_room();
        let Some(task) = self.task.as_mut() else {
            return std::future::pending().await;
        };
        let budget = &self.budget;
        let room = async {
            while budget.queued.load(Ordering::Acquire) >= OUTBOUND_BUDGET_BYTES {
                budget.drained.notified().await;
            }
            // Fires only when the loop was paused; with room already, park so
            // this branch never spins the loop.
        };
        tokio::select! {
            joined = task => {
                self.task = None;
                SinkEvent::Finished(joined.unwrap_or_else(|e| Err(io::Error::other(e))))
            }
            () = room, if paused => SinkEvent::Room,
        }
    }

    /// Stop accepting frames, let the queued ones drain for at most `limit`,
    /// then close the socket.
    pub async fn close(mut self, limit: Duration) {
        let Some(mut task) = self.task.take() else {
            return;
        };
        // Dropping the sink drops the sender: the task drains and returns.
        drop(self);
        if tokio::time::timeout(limit, &mut task).await.is_err() {
            task.abort();
        }
    }
}

impl Drop for WorkerSink {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

/// The writer task: write each queued frame under the progress deadline.
async fn run_writer(
    mut writer: BoxedWriter,
    mut rx: mpsc::UnboundedReceiver<Vec<u8>>,
    budget: Arc<Budget>,
) -> io::Result<()> {
    while let Some(frame) = rx.recv().await {
        write_with_progress_deadline(&mut writer, &frame, WRITE_STALL_TIMEOUT).await?;
        budget.queued.fetch_sub(frame.len(), Ordering::AcqRel);
        // A stored permit if nobody waits yet, so a wake is never missed.
        budget.drained.notify_one();
    }
    Ok(())
}

/// Write all of `buf`, failing with [`io::ErrorKind::TimedOut`] if any single
/// write (or the final flush) accepts nothing for `stall`.
pub(crate) async fn write_with_progress_deadline<W>(
    writer: &mut W,
    buf: &[u8],
    stall: Duration,
) -> io::Result<()>
where
    W: AsyncWrite + Unpin + ?Sized,
{
    let stalled = || {
        io::Error::new(
            io::ErrorKind::TimedOut,
            format!("worker accepted no bytes for {stall:?}: it has stopped reading"),
        )
    };
    let mut written = 0;
    while written < buf.len() {
        match tokio::time::timeout(stall, writer.write(&buf[written..])).await {
            Ok(Ok(0)) => return Err(io::ErrorKind::WriteZero.into()),
            Ok(Ok(n)) => written += n,
            Ok(Err(e)) => return Err(e),
            Err(_) => return Err(stalled()),
        }
    }
    tokio::time::timeout(stall, writer.flush())
        .await
        .map_err(|_| stalled())?
}

#[cfg(test)]
mod tests;
