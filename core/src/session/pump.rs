//! Shared terminal output pump.
//!
//! Both the desktop runtime and the remote agent read raw PTY/transport output
//! off a bounded [`tokio::sync::mpsc`] channel and forward it to their frontend.
//! The *mechanics* of that forwarding — an optional startup buffer-until-clear
//! phase, then a coalescing streaming phase with the PERF-012 zero-copy fast
//! path — are identical across both runtimes. Only the delivery target differs,
//! and that difference is already abstracted behind [`OutputSink`].
//!
//! [`run_output_pump`] owns the loop; consumers inject *where* the bytes go via
//! [`OutputSink`] and decide *how* to frame them via [`PumpOptions`]. This is a
//! behaviour-preserving extraction of the desktop `run_output_reader` loop
//! (finding DUP-011): the byte framing, the two `biased` cancel-first selects,
//! and the settle-vs-no-settle asymmetry on sink failure are all preserved
//! exactly — the pump reports *why* it ended via [`PumpEnd`] and leaves the
//! tier-specific "settle" (exit event + drop-fold) to the caller.

use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::mpsc::Receiver;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::output::coalescer::OutputCoalescer;
use crate::output::screen_clear::ScreenClearDetector;
use crate::session::traits::OutputSink;

/// Framing/behaviour knobs for [`run_output_pump`].
#[derive(Debug, Clone)]
pub struct PumpOptions {
    /// Buffer startup output until the screen-clear sequence (or a timeout)
    /// before streaming, flushing the buffered prefix as a single batch.
    pub wait_for_clear: bool,
    /// Coalesce already-queued chunks into one batch per send (desktop IPC
    /// reduction, PERF-012). When `false`, every received chunk is delivered as
    /// its own `send_output` call — required by transports whose on-wire
    /// notification framing must mirror the chunk boundaries (the agent path).
    pub coalesce: bool,
    /// Upper bound on a single coalesced batch. Ignored when `coalesce` is
    /// `false`.
    pub max_coalesce_bytes: usize,
    /// How long the `wait_for_clear` phase buffers before flushing anyway.
    pub clear_wait_timeout: Duration,
    /// Frontend flow control (PERF2-002). While the gate is paused the
    /// streaming phase stops reading `rx`, so the bounded channel fills and the
    /// producer (the PTY reader thread) blocks — the OS PTY buffer then
    /// backpressures the program. `None` never pauses. Only wire this up when
    /// the producer *blocks* on a full channel: a producer that `try_send`s
    /// would drop output instead.
    pub flow: Option<OutputFlowGate>,
}

/// Pause/resume switch the frontend flips when xterm.js falls behind
/// (PERF2-002, the xterm write-callback watermark pattern).
///
/// Clones share one state: the session manager keeps one to apply the
/// frontend's pause/resume, the pump holds another and waits on it. Pausing
/// only stops the pump *reading* output; input (Ctrl+C included) takes a
/// separate path and is never held back.
#[derive(Debug, Clone)]
pub struct OutputFlowGate {
    paused: Arc<watch::Sender<bool>>,
}

impl Default for OutputFlowGate {
    fn default() -> Self {
        Self::new()
    }
}

impl OutputFlowGate {
    /// A gate that starts out flowing (not paused).
    #[must_use]
    pub fn new() -> Self {
        Self {
            paused: Arc::new(watch::Sender::new(false)),
        }
    }

    /// Stop the pump reading output.
    pub fn pause(&self) {
        self.set_paused(true);
    }

    /// Let the pump read output again.
    pub fn resume(&self) {
        self.set_paused(false);
    }

    /// Set the paused state; waking the pump when it changes.
    pub fn set_paused(&self, paused: bool) {
        self.paused.send_if_modified(|current| {
            let changed = *current != paused;
            *current = paused;
            changed
        });
    }

    /// Whether the gate is currently paused.
    #[must_use]
    pub fn is_paused(&self) -> bool {
        *self.paused.borrow()
    }

    /// Resolve once the gate is (or becomes) not paused.
    async fn wait_resumed(&self) {
        self.wait_state(false).await;
    }

    /// Resolve once the gate is (or becomes) paused.
    async fn wait_paused(&self) {
        self.wait_state(true).await;
    }

    async fn wait_state(&self, paused: bool) {
        let mut rx = self.paused.subscribe();
        // The gate owns the sender, so the wait cannot observe it closing.
        let _ = rx.wait_for(|current| *current == paused).await;
    }
}

/// Resolve when `gate` becomes paused; never when there is no gate.
async fn paused(gate: Option<&OutputFlowGate>) {
    match gate {
        Some(gate) => gate.wait_paused().await,
        None => std::future::pending::<()>().await,
    }
}

/// Why [`run_output_pump`] returned.
///
/// The caller maps this onto its tier-specific end-of-stream handling. The
/// distinction between the two sink-closed variants preserves the desktop
/// asymmetry: a streaming-phase failure still settles the session (exit event),
/// but a failure while flushing the pre-stream clear buffer does **not** — it
/// returns without settling, exactly as the original loop did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PumpEnd {
    /// The output channel closed (the process's output ended). Normal exit.
    Eof,
    /// The cancellation token fired (deterministic teardown, CONC-011).
    Cancelled,
    /// The sink rejected the pre-stream clear-flush batch. The caller must
    /// return **without** settling the session (no exit event), matching the
    /// original no-settle path.
    ClearFlushSinkClosed,
    /// The sink rejected a streaming-phase batch (e.g. the webview closed).
    StreamSinkClosed,
}

/// Await the token if present; otherwise never resolve.
///
/// Lets the `biased` selects treat an absent cancellation token as a future
/// that is simply never ready, so the same loop serves both the desktop (token
/// present) and the agent (token absent) callers unchanged.
async fn cancelled(cancel: Option<&CancellationToken>) {
    match cancel {
        Some(token) => token.cancelled().await,
        None => std::future::pending::<()>().await,
    }
}

/// Pump output from `rx` into `sink` until the stream ends, cancels, or the
/// sink closes.
///
/// This is the shared body of the desktop `run_output_reader` (finding
/// DUP-011). Its two phases are moved verbatim from that loop:
///
/// - **Phase 1** (`opts.wait_for_clear`): buffer startup output until a
///   [`ScreenClearDetector`] sees the clear sequence or `clear_wait_timeout`
///   elapses, then flush the buffered prefix as one batch. A cancel or channel
///   close *during* buffering flushes best-effort (ignoring a sink error) and
///   returns [`PumpEnd::Cancelled`] / [`PumpEnd::Eof`]. The post-clear flush,
///   by contrast, **honours** a sink error and returns
///   [`PumpEnd::ClearFlushSinkClosed`] — the no-settle asymmetry.
/// - **Phase 2**: coalescing streaming with the PERF-012 zero-copy fast path.
///   An owned chunk with nothing queued behind it is handed to the sink
///   uncopied; 2+ queued chunks concatenate into one contiguous batch (bounded
///   by `max_coalesce_bytes`); a first chunk already at/over the cap is
///   delivered alone. With `coalesce: false`, every chunk is delivered on its
///   own.
///
/// The caller owns the "settle" step (exit event, drop-fold) — see [`PumpEnd`].
pub async fn run_output_pump<S: OutputSink>(
    session_id: &str,
    rx: &mut Receiver<Vec<u8>>,
    sink: &S,
    cancel: Option<&CancellationToken>,
    opts: &PumpOptions,
) -> PumpEnd {
    // Phase 1: optionally buffer until the screen-clear sequence.
    if opts.wait_for_clear {
        let deadline = Instant::now() + opts.clear_wait_timeout;

        let mut buffer = Vec::new();
        let mut detector = ScreenClearDetector::new();

        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            let recv = tokio::select! {
                biased;
                // Deterministic teardown while still buffering startup output
                // (CONC-011): flush what we have best-effort and let the caller
                // settle, rather than waiting for the channel to close.
                _ = cancelled(cancel) => {
                    let _ = sink.send_output(session_id, buffer);
                    return PumpEnd::Cancelled;
                }
                res = tokio::time::timeout(remaining, rx.recv()) => res,
            };
            match recv {
                Ok(Some(chunk)) => {
                    let cleared = detector.feed(&chunk);
                    buffer.extend_from_slice(&chunk);
                    if cleared {
                        break;
                    }
                }
                Ok(None) => {
                    // Channel closed during startup.
                    let _ = sink.send_output(session_id, buffer);
                    return PumpEnd::Eof;
                }
                Err(_) => break, // Timeout
            }
        }

        // Flush the buffered output as a single batch. Unlike the terminal
        // flushes above, this HONORS a sink error: the original loop returned
        // here without running its end-of-stream cleanup (old manager.rs:1968),
        // so the caller must not settle either.
        if !buffer.is_empty() && sink.send_output(session_id, buffer).is_err() {
            return PumpEnd::ClearFlushSinkClosed;
        }
    }

    // Phase 2: normal streaming with coalescing.
    //
    // Fast path (the common case, PERF-012): when a chunk arrives and no
    // further chunk is already buffered, the owned `Vec` received from the
    // channel is handed straight to the sink — it is never copied through the
    // coalescer's pending buffer. The coalescer only takes a copy when 2+ chunks
    // must be concatenated into a single batch, where that concatenation copy is
    // load-bearing (it produces the contiguous batch).
    //
    // Framing stays byte-for-byte identical to the always-coalesce form: a chunk
    // merges with the next only when that next chunk is already available AND the
    // running batch is still under `max_coalesce_bytes` — exactly the guard the
    // original loop applied. A first chunk already at or above the cap is
    // delivered alone. With `coalesce: false` no chunk is ever merged, so each
    // delivery mirrors one received chunk (the agent's on-wire framing).
    let mut coalescer = OutputCoalescer::new();
    loop {
        // Flow control (PERF2-002): while the frontend reports xterm is
        // backlogged, do not read the channel. Cancel still wins so teardown
        // is never held up by a paused stream.
        if let Some(gate) = opts.flow.as_ref().filter(|g| g.is_paused()) {
            tokio::select! {
                biased;
                _ = cancelled(cancel) => return PumpEnd::Cancelled,
                _ = gate.wait_resumed() => {}
            }
        }
        // Normal delivery is the `recv` arm; the `cancel` arm only fires on
        // deterministic teardown (CONC-011). `biased` checks cancel first, but
        // it is never ready during normal streaming, so a chunk is always taken
        // when one is available — delivery/coalescing is unchanged. Both futures
        // are cancel-safe, so no pending chunk is lost.
        let first_chunk = tokio::select! {
            biased;
            _ = cancelled(cancel) => return PumpEnd::Cancelled,
            // A pause that lands while we wait for output takes effect before
            // the next chunk is read (`recv` is cancel-safe, nothing is lost).
            _ = paused(opts.flow.as_ref()) => continue,
            chunk = rx.recv() => match chunk {
                Some(chunk) => chunk,
                None => return PumpEnd::Eof,
            },
        };
        let data = if !opts.coalesce || first_chunk.len() >= opts.max_coalesce_bytes {
            first_chunk
        } else {
            match rx.try_recv() {
                // Nothing else buffered: pass the owned chunk through uncopied.
                Err(_) => first_chunk,
                // More output waiting: concatenate into one contiguous batch.
                Ok(second) => {
                    coalescer.push(&first_chunk);
                    coalescer.push(&second);
                    while coalescer.pending_len() < opts.max_coalesce_bytes {
                        match rx.try_recv() {
                            Ok(chunk) => coalescer.push(&chunk),
                            Err(_) => break,
                        }
                    }
                    // Two non-empty chunks were pushed, so flush is Some; fall
                    // back to the owned first chunk without panicking.
                    coalescer.flush().unwrap_or(first_chunk)
                }
            }
        };

        if data.is_empty() {
            continue;
        }

        if sink.send_output(session_id, data).is_err() {
            return PumpEnd::StreamSinkClosed;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::{Arc, Mutex};

    use crate::errors::SessionError;
    use tokio::sync::mpsc;

    /// Each recorded `send_output` batch: `(session_id, bytes)`.
    type OutputRecord = Vec<(String, Vec<u8>)>;

    /// A fake [`OutputSink`] recording every forwarded `(session_id, bytes)`
    /// batch, optionally failing `send_output` after a configurable number of
    /// successful sends (to exercise the sink-closed paths).
    struct FakeSink {
        outputs: Arc<Mutex<OutputRecord>>,
        /// Number of successful sends before `send_output` starts returning Err.
        /// `usize::MAX` never fails.
        fail_after: usize,
    }

    impl FakeSink {
        fn new() -> Self {
            Self {
                outputs: Arc::new(Mutex::new(Vec::new())),
                fail_after: usize::MAX,
            }
        }

        /// Fails on the send whose 0-based index is `n` (and every send after).
        fn failing_after(n: usize) -> Self {
            Self {
                outputs: Arc::new(Mutex::new(Vec::new())),
                fail_after: n,
            }
        }

        fn recorded(&self) -> OutputRecord {
            self.outputs.lock().unwrap().clone()
        }
    }

    impl OutputSink for FakeSink {
        fn send_output(&self, session_id: &str, data: Vec<u8>) -> Result<(), SessionError> {
            let mut outputs = self.outputs.lock().unwrap();
            if outputs.len() >= self.fail_after {
                return Err(SessionError::Io(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "fake sink closed",
                )));
            }
            outputs.push((session_id.to_string(), data));
            Ok(())
        }

        fn send_exit(
            &self,
            _session_id: &str,
            _exit_code: Option<i32>,
        ) -> Result<(), SessionError> {
            Ok(())
        }

        fn send_error(&self, _session_id: &str, _message: &str) -> Result<(), SessionError> {
            Ok(())
        }
    }

    fn stream_opts() -> PumpOptions {
        PumpOptions {
            wait_for_clear: false,
            coalesce: true,
            max_coalesce_bytes: 32 * 1024,
            clear_wait_timeout: Duration::from_secs(5),
            flow: None,
        }
    }

    /// Flatten recorded batches into one byte vector (delivery order preserved).
    fn combined(sink: &FakeSink) -> Vec<u8> {
        sink.recorded()
            .into_iter()
            .flat_map(|(_, d)| d)
            .collect::<Vec<u8>>()
    }

    #[tokio::test]
    async fn forwards_chunks_in_order_then_eof() {
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(16);
        tx.send(b"hello ".to_vec()).await.unwrap();
        tx.send(b"world".to_vec()).await.unwrap();
        drop(tx); // EOF

        let sink = FakeSink::new();
        let end = run_output_pump("s1", &mut rx, &sink, None, &stream_opts()).await;

        assert_eq!(end, PumpEnd::Eof);
        assert_eq!(combined(&sink), b"hello world");
        // Every batch is addressed to the pump's session id.
        assert!(sink.recorded().iter().all(|(sid, _)| sid == "s1"));
    }

    #[tokio::test]
    async fn coalesce_true_merges_queued_chunks_into_one_batch() {
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(16);
        tx.send(b"aaa".to_vec()).await.unwrap();
        tx.send(b"bbb".to_vec()).await.unwrap();
        tx.send(b"ccc".to_vec()).await.unwrap();
        drop(tx);

        let sink = FakeSink::new();
        let end = run_output_pump("s1", &mut rx, &sink, None, &stream_opts()).await;

        assert_eq!(end, PumpEnd::Eof);
        let recorded = sink.recorded();
        assert_eq!(recorded.len(), 1, "queued chunks coalesce into one batch");
        assert_eq!(recorded[0].1, b"aaabbbccc");
    }

    #[tokio::test]
    async fn coalesce_true_single_chunk_is_byte_exact() {
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(16);
        tx.send(b"solo".to_vec()).await.unwrap();
        drop(tx);

        let sink = FakeSink::new();
        run_output_pump("s1", &mut rx, &sink, None, &stream_opts()).await;

        let recorded = sink.recorded();
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].1, b"solo");
    }

    #[tokio::test]
    async fn coalesce_true_oversized_first_chunk_delivered_alone() {
        let max = 64;
        let big = vec![b'x'; max + 16];
        let small = b"tail".to_vec();

        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(16);
        tx.send(big.clone()).await.unwrap();
        tx.send(small.clone()).await.unwrap();
        drop(tx);

        let opts = PumpOptions {
            max_coalesce_bytes: max,
            ..stream_opts()
        };
        let sink = FakeSink::new();
        run_output_pump("s1", &mut rx, &sink, None, &opts).await;

        let recorded = sink.recorded();
        assert_eq!(recorded.len(), 2, "oversized first chunk must not merge");
        assert_eq!(recorded[0].1, big);
        assert_eq!(recorded[1].1, small);
    }

    #[tokio::test]
    async fn coalesce_false_delivers_one_send_per_chunk() {
        // Guards the deferred agent path: with coalescing off, the pump must
        // emit exactly one send_output per received chunk so the on-wire
        // notification framing mirrors the chunk boundaries.
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(16);
        tx.send(b"aaa".to_vec()).await.unwrap();
        tx.send(b"bbb".to_vec()).await.unwrap();
        tx.send(b"ccc".to_vec()).await.unwrap();
        drop(tx);

        let opts = PumpOptions {
            coalesce: false,
            ..stream_opts()
        };
        let sink = FakeSink::new();
        let end = run_output_pump("s1", &mut rx, &sink, None, &opts).await;

        assert_eq!(end, PumpEnd::Eof);
        let recorded = sink.recorded();
        assert_eq!(
            recorded.len(),
            3,
            "no chunk may be merged when coalesce=false"
        );
        assert_eq!(recorded[0].1, b"aaa");
        assert_eq!(recorded[1].1, b"bbb");
        assert_eq!(recorded[2].1, b"ccc");
    }

    #[tokio::test]
    async fn wait_for_clear_buffers_until_clear_then_flushes_one_batch() {
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(16);
        // Pre-clear output, then the clear sequence, then post-clear output.
        tx.send(b"boot noise".to_vec()).await.unwrap();
        tx.send(b"\x1b[2J\x1b[H".to_vec()).await.unwrap();
        tx.send(b"prompt".to_vec()).await.unwrap();
        drop(tx);

        let opts = PumpOptions {
            wait_for_clear: true,
            ..stream_opts()
        };
        let sink = FakeSink::new();
        let end = run_output_pump("s1", &mut rx, &sink, None, &opts).await;

        assert_eq!(end, PumpEnd::Eof);
        let recorded = sink.recorded();
        // First batch is the buffered-until-clear prefix as a single flush.
        assert_eq!(recorded[0].1, b"boot noise\x1b[2J\x1b[H");
        // All bytes preserved end to end.
        assert_eq!(combined(&sink), b"boot noise\x1b[2J\x1b[Hprompt");
    }

    #[tokio::test]
    async fn wait_for_clear_timeout_flushes_then_streams() {
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(16);
        tx.send(b"no clear here".to_vec()).await.unwrap();

        let opts = PumpOptions {
            wait_for_clear: true,
            clear_wait_timeout: Duration::from_millis(60),
            ..stream_opts()
        };
        let sink = FakeSink::new();

        // Feed a post-timeout chunk while the pump runs, then close.
        let feeder = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            tx.send(b"live".to_vec()).await.unwrap();
            drop(tx);
        });

        let end = run_output_pump("s1", &mut rx, &sink, None, &opts).await;
        feeder.await.unwrap();

        assert_eq!(end, PumpEnd::Eof);
        // The timeout flushed the buffered prefix, then streaming delivered the
        // later chunk — all bytes present, in order.
        assert_eq!(combined(&sink), b"no clear herelive");
        assert_eq!(sink.recorded()[0].1, b"no clear here");
    }

    #[tokio::test]
    async fn cancel_during_streaming_returns_cancelled_without_hang() {
        // Keep the sender alive so EOF is impossible: only the cancel token can
        // end the pump. Completing at all proves the cancel stopped it.
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(16);
        let cancel = CancellationToken::new();
        let cancel_child = cancel.clone();
        let sink = FakeSink::new();
        let outputs = sink.outputs.clone();

        let handle = tokio::spawn(async move {
            run_output_pump("s1", &mut rx, &sink, Some(&cancel_child), &stream_opts()).await
        });

        cancel.cancel();
        let end = tokio::time::timeout(Duration::from_secs(5), handle)
            .await
            .expect("pump did not stop after cancellation")
            .expect("pump task panicked");

        assert_eq!(end, PumpEnd::Cancelled);
        assert!(outputs.lock().unwrap().is_empty());
        drop(tx);
    }

    #[tokio::test]
    async fn sink_err_during_streaming_returns_stream_sink_closed() {
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(16);
        tx.send(b"data".to_vec()).await.unwrap();
        // Sender stays alive; only the sink failure can end the pump.

        let sink = FakeSink::failing_after(0); // fail on the very first send
        let end = run_output_pump("s1", &mut rx, &sink, None, &stream_opts()).await;

        assert_eq!(end, PumpEnd::StreamSinkClosed);
        assert!(sink.recorded().is_empty());
        drop(tx);
    }

    #[tokio::test]
    async fn sink_err_on_pre_stream_clear_flush_returns_clear_flush_sink_closed() {
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(16);
        tx.send(b"boot".to_vec()).await.unwrap();
        tx.send(b"\x1b[2J".to_vec()).await.unwrap();
        tx.send(b"after".to_vec()).await.unwrap();
        drop(tx);

        let opts = PumpOptions {
            wait_for_clear: true,
            ..stream_opts()
        };
        // Fail on the first send — which is the post-clear flush.
        let sink = FakeSink::failing_after(0);
        let end = run_output_pump("s1", &mut rx, &sink, None, &opts).await;

        assert_eq!(end, PumpEnd::ClearFlushSinkClosed);
    }

    #[tokio::test]
    async fn sink_err_on_terminal_clear_flush_is_swallowed_returns_eof() {
        // Channel closes while still buffering (no clear seen): the terminal
        // flush is best-effort, so a sink error is swallowed and the pump still
        // reports the natural end (Eof).
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(16);
        tx.send(b"partial".to_vec()).await.unwrap();
        drop(tx); // EOF during buffering

        let opts = PumpOptions {
            wait_for_clear: true,
            ..stream_opts()
        };
        let sink = FakeSink::failing_after(0);
        let end = run_output_pump("s1", &mut rx, &sink, None, &opts).await;

        assert_eq!(end, PumpEnd::Eof);
    }

    #[tokio::test]
    async fn cancel_on_terminal_clear_flush_is_swallowed_returns_cancelled() {
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(16);
        tx.send(b"partial".to_vec()).await.unwrap();
        // Keep tx alive; cancel while buffering.

        let cancel = CancellationToken::new();
        cancel.cancel();

        let opts = PumpOptions {
            wait_for_clear: true,
            ..stream_opts()
        };
        let sink = FakeSink::failing_after(0);
        let end = run_output_pump("s1", &mut rx, &sink, Some(&cancel), &opts).await;

        assert_eq!(end, PumpEnd::Cancelled);
        drop(tx);
    }
    /// Poll `cond` until it holds or a generous deadline passes.
    async fn eventually(mut cond: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if cond() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        cond()
    }

    #[tokio::test]
    async fn paused_gate_stops_reading_until_resumed() {
        // PERF2-002: while the frontend reports xterm is backlogged, the pump
        // must not read the channel at all, so the bounded channel fills and
        // backpressures the PTY reader.
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(2);
        let gate = OutputFlowGate::new();
        gate.pause();
        let opts = PumpOptions {
            flow: Some(gate.clone()),
            ..stream_opts()
        };
        let sink = FakeSink::new();
        let outputs = sink.outputs.clone();
        let handle =
            tokio::spawn(async move { run_output_pump("s1", &mut rx, &sink, None, &opts).await });

        tx.send(b"one".to_vec()).await.unwrap();
        tx.send(b"two".to_vec()).await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;

        assert!(outputs.lock().unwrap().is_empty(), "paused pump forwarded");
        // Nothing was read: the channel is full and a producer is refused.
        assert!(
            tx.try_send(b"three".to_vec()).is_err(),
            "paused pump drained the channel (no backpressure)"
        );

        gate.resume();
        let delivered = eventually(|| {
            outputs
                .lock()
                .unwrap()
                .iter()
                .flat_map(|(_, d)| d.clone())
                .collect::<Vec<u8>>()
                == b"onetwo"
        })
        .await;
        assert!(delivered, "resumed pump did not deliver the queued output");

        drop(tx);
        let end = tokio::time::timeout(Duration::from_secs(5), handle)
            .await
            .expect("pump did not finish")
            .expect("pump task panicked");
        assert_eq!(end, PumpEnd::Eof);
    }

    #[tokio::test]
    async fn pause_mid_stream_holds_later_chunks_without_loss() {
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(16);
        let gate = OutputFlowGate::new();
        let opts = PumpOptions {
            flow: Some(gate.clone()),
            ..stream_opts()
        };
        let sink = FakeSink::new();
        let outputs = sink.outputs.clone();
        let handle =
            tokio::spawn(async move { run_output_pump("s1", &mut rx, &sink, None, &opts).await });

        tx.send(b"before ".to_vec()).await.unwrap();
        assert!(eventually(|| outputs.lock().unwrap().len() == 1).await);

        gate.pause();
        // Let the pump observe the pause before more output arrives.
        tokio::time::sleep(Duration::from_millis(20)).await;
        tx.send(b"during ".to_vec()).await.unwrap();
        tx.send(b"pause".to_vec()).await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(outputs.lock().unwrap().len(), 1, "paused pump forwarded");

        gate.resume();
        drop(tx);
        let end = tokio::time::timeout(Duration::from_secs(5), handle)
            .await
            .expect("pump did not finish")
            .expect("pump task panicked");
        assert_eq!(end, PumpEnd::Eof);
        let all: Vec<u8> = outputs
            .lock()
            .unwrap()
            .iter()
            .flat_map(|(_, d)| d.clone())
            .collect();
        assert_eq!(all, b"before during pause", "output lost or reordered");
    }

    #[tokio::test]
    async fn cancel_while_paused_returns_cancelled() {
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(16);
        tx.send(b"queued".to_vec()).await.unwrap();
        let gate = OutputFlowGate::new();
        gate.pause();
        let opts = PumpOptions {
            flow: Some(gate),
            ..stream_opts()
        };
        let cancel = CancellationToken::new();
        let child = cancel.clone();
        let sink = FakeSink::new();
        let handle = tokio::spawn(async move {
            run_output_pump("s1", &mut rx, &sink, Some(&child), &opts).await
        });

        tokio::time::sleep(Duration::from_millis(20)).await;
        cancel.cancel();
        let end = tokio::time::timeout(Duration::from_secs(5), handle)
            .await
            .expect("paused pump ignored cancellation")
            .expect("pump task panicked");
        assert_eq!(end, PumpEnd::Cancelled);
        drop(tx);
    }

    #[test]
    fn gate_set_paused_toggles_state() {
        let gate = OutputFlowGate::default();
        assert!(!gate.is_paused());
        gate.set_paused(true);
        assert!(gate.is_paused());
        // Clones share state: the manager holds one, the pump another.
        let clone = gate.clone();
        clone.set_paused(false);
        assert!(!gate.is_paused());
    }
}
