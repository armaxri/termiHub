//! The telnet reader thread: bridges blocking TCP reads to the async output
//! channel, answers option negotiation, and drives the optional auto-login.

use std::io::Read;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tracing::{debug, info};

use super::auto_login::{AutoLogin, AutoLoginConfig, Outcome};
use super::negotiation::Negotiator;
use super::{write_locked, SharedWriter, TelnetFilter};
use crate::connection::OutputSender;

/// Everything the reader thread needs.
pub(super) struct ReaderContext {
    /// A `try_clone()` of the session socket, with a read timeout set.
    pub stream: TcpStream,
    /// The shared write half — negotiation replies and auto-login lines are
    /// written through it so they never interleave with user input mid-write.
    pub writer: Arc<SharedWriter>,
    pub negotiator: Arc<Mutex<Negotiator>>,
    pub alive: Arc<AtomicBool>,
    pub output_tx: Arc<Mutex<Option<OutputSender>>>,
    pub auto_login: Option<AutoLoginConfig>,
}

/// Spawn the reader thread.
pub(super) fn spawn(ctx: ReaderContext) {
    std::thread::spawn(move || run(ctx));
}

fn run(mut ctx: ReaderContext) {
    let mut buf = [0u8; 4096];
    let mut filter = TelnetFilter::new();
    let mut auto_login = ctx
        .auto_login
        .take()
        .map(|cfg| AutoLogin::new(cfg, Instant::now()));

    while ctx.alive.load(Ordering::SeqCst) {
        match ctx.stream.read(&mut buf) {
            Ok(0) => {
                debug!("Telnet server closed the connection");
                break;
            }
            Ok(n) => {
                let Some(filtered) = negotiate(&ctx, &mut filter, &buf[..n]) else {
                    break;
                };
                if let Some(login) = auto_login.as_mut() {
                    if let Some(line) = login.on_output(&filtered, Instant::now()) {
                        // A failed write shuts the socket down (see `write_locked`),
                        // so the next read ends the session.
                        let _ = write_locked(&ctx.writer, &line);
                    }
                }
                if !filtered.is_empty() && !forward(&ctx, filtered) {
                    break;
                }
            }
            Err(ref e) if is_read_timeout(e) => {}
            Err(e) => {
                debug!(error = %e, "Telnet read failed; ending the session");
                break;
            }
        }
        if let Some(login) = auto_login.as_mut() {
            login.on_tick(Instant::now());
            if let Some(outcome) = login.outcome() {
                log_outcome(outcome);
                // Drops any remaining credentials with the state machine.
                auto_login = None;
            }
        }
    }
    end_session(&ctx);
}

/// Mark the session dead and, when this thread is the one that found it dead,
/// drop the stored output sender (#5569).
///
/// The session manager only learns that a session ended when its output
/// channel closes. The reader used to clear `alive` and leave the sender in
/// place, so a server-side close (EOF) or a read error left the tab green and
/// `connected` with no disconnect overlay and no Reconnect: a dead connection
/// that looked alive. Dropping the sender ends the channel, the manager emits
/// `terminal-exit`, and the tab shows the disconnect overlay. This matches the
/// serial and SSH readers.
///
/// When `alive` was already `false`, something else stopped the session —
/// [`disconnect`](crate::connection::ConnectionType::disconnect) (which clears
/// the sender itself), `interrupt_io` (followed by a disconnect) or the
/// [`Drop`] guard. Then the sender is left alone: by the time this thread
/// notices, the same `Telnet` may already be connected again, and the sender
/// in `output_tx` would belong to that new connection.
pub(super) fn end_session(ctx: &ReaderContext) {
    if !ctx.alive.swap(false, Ordering::SeqCst) {
        return;
    }
    let sender = match ctx.output_tx.lock() {
        Ok(mut guard) => guard.take(),
        Err(poisoned) => poisoned.into_inner().take(),
    };
    drop(sender);
}

/// Whether a read error is only the socket's read timeout (`READ_TIMEOUT`),
/// which wakes the loop for its `alive` and auto-login checks.
///
/// Unix reports an `SO_RCVTIMEO` expiry as `EAGAIN` (`WouldBlock`) and keeps
/// `ETIMEDOUT` (`TimedOut`) for a connection that really timed out, such as a
/// peer that failed the TCP keepalive probes. That one ends the session: if it
/// were taken for a quiet socket, a half-open connection would stay
/// `connected` forever. Windows reports its read timeout as `WSAETIMEDOUT`,
/// which maps to `TimedOut`, so there it counts as a timeout too.
pub(super) fn is_read_timeout(e: &std::io::Error) -> bool {
    match e.kind() {
        std::io::ErrorKind::WouldBlock => true,
        std::io::ErrorKind::TimedOut => cfg!(windows),
        _ => false,
    }
}

/// Run one chunk through the filter, writing any negotiation replies. Returns
/// the user-visible data, or `None` if the negotiator lock is poisoned.
fn negotiate(ctx: &ReaderContext, filter: &mut TelnetFilter, chunk: &[u8]) -> Option<Vec<u8>> {
    let mut negotiator = ctx.negotiator.lock().ok()?;
    let mut responses = Vec::new();
    let filtered = filter.filter(chunk, &mut negotiator, &mut responses);
    if !responses.is_empty() {
        // Written under the negotiator lock (lock order negotiator → writer)
        // so a size report never races a concurrent resize. A failed write
        // shuts the socket down (see `write_locked`), so the next read ends
        // the session.
        let _ = write_locked(&ctx.writer, &responses);
    }
    Some(filtered)
}

/// Forward output to the current subscriber. Returns `false` when the session
/// has no subscriber any more (disconnected) and the thread should stop.
fn forward(ctx: &ReaderContext, data: Vec<u8>) -> bool {
    // Clone the sender out of the guard and DROP the lock BEFORE the blocking
    // send. `blocking_send` parks this thread under backpressure (full
    // channel), so holding `output_tx` across it would stall any path that
    // needs the same lock (teardown clearing the sender, or a disconnect)
    // behind a reader that is itself blocked — a lockup where the session can
    // neither drain nor be torn down (CONC-010). Senders are cheap to clone.
    let sender = match ctx.output_tx.lock() {
        Ok(guard) => match guard.as_ref() {
            Some(sender) => sender.clone(),
            // No sender — disconnected.
            None => return false,
        },
        Err(_) => return false,
    };
    let _ = sender.blocking_send(data);
    true
}

/// Log how auto-login ended — never the credentials.
fn log_outcome(outcome: Outcome) {
    match outcome {
        Outcome::Completed => info!("Telnet auto-login: credentials sent"),
        Outcome::TimedOut => {
            info!("Telnet auto-login: prompt not seen in time; session left interactive")
        }
        Outcome::Abandoned => {
            debug!("Telnet auto-login: unexpected prompt; session left interactive")
        }
    }
}
