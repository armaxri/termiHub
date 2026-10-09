//! Untrusted-peer validation of runner frames (#4182): what the host accepts,
//! what it ignores, and what kills the runner.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use termihub_plugin_runner::ipc::{
    Alive, Heartbeat, Hello, Log, Message, SessionRef, SyscallDenial, PROTOCOL_VERSION,
};
use termihub_plugin_runner::sandbox::denial::denial_log;

use super::*;
use crate::plugin::sandbox::OutputRateCap;

fn shared() -> Arc<Shared> {
    Shared::new(
        "probe".to_owned(),
        None,
        Arc::new(PluginLogLimiter::default()),
    )
}

/// Register a session the way `SandboxedPlugin::register_session` does.
fn register(shared: &Shared) -> (u32, Arc<AtomicBool>, tokio::sync::mpsc::Receiver<Vec<u8>>) {
    let id = shared.next_session.fetch_add(1, Ordering::SeqCst);
    let alive = Arc::new(AtomicBool::new(true));
    let (tx, rx) = tokio::sync::mpsc::channel(8);
    shared.sessions.lock().unwrap().insert(
        id,
        SessionSlot {
            output: Arc::new(Mutex::new(Some(tx))),
            alive: Arc::clone(&alive),
            reply: None,
        },
    );
    (id, alive, rx)
}

fn log(session_id: Option<u32>, level: u32, message: String) -> Message {
    Message::Log(Log {
        session_id,
        level,
        message,
        truncated: false,
        denied: None,
    })
}

#[test]
fn output_for_a_live_session_is_delivered() {
    let shared = shared();
    let (id, _alive, mut rx) = register(&shared);
    shared
        .dispatch(Message::Output {
            session_id: id,
            data: b"hi".to_vec(),
        })
        .unwrap();
    assert_eq!(rx.try_recv().unwrap(), b"hi");
}

#[test]
fn frames_for_a_never_allocated_session_are_violations() {
    let shared = shared();
    let (id, _alive, _rx) = register(&shared);
    for bad in [0, id + 1, u32::MAX] {
        assert!(shared
            .dispatch(Message::Output {
                session_id: bad,
                data: vec![]
            })
            .is_err());
        assert!(shared
            .dispatch(Message::Alive(Alive {
                session_id: bad,
                alive: false
            }))
            .is_err());
        assert!(shared
            .dispatch(Message::Closed(SessionRef { session_id: bad }))
            .is_err());
        assert!(shared.dispatch(log(Some(bad), 3, "x".into())).is_err());
    }
}

#[test]
fn late_frames_for_a_retired_session_are_ignored() {
    let shared = shared();
    let (id, _alive, _rx) = register(&shared);
    shared.retire(id);
    assert!(shared
        .dispatch(Message::Output {
            session_id: id,
            data: b"late".to_vec()
        })
        .is_ok());
    assert!(shared
        .dispatch(Message::Closed(SessionRef { session_id: id }))
        .is_ok());
}

#[test]
fn alive_updates_flip_session_liveness() {
    let shared = shared();
    let (id, alive, _rx) = register(&shared);
    shared
        .dispatch(Message::Alive(Alive {
            session_id: id,
            alive: false,
        }))
        .unwrap();
    assert!(!alive.load(Ordering::SeqCst));
}

#[test]
fn log_lines_are_bounded_and_levels_checked() {
    let shared = shared();
    assert!(shared.dispatch(log(None, 3, "fine".into())).is_ok());
    assert!(shared.dispatch(log(None, 0, "bad level".into())).is_err());
    assert!(shared.dispatch(log(None, 99, "bad level".into())).is_err());
    // Over the bound even after lossy decoding: a hostile runner.
    let huge = "x".repeat(MAX_WIRE_LOG_BYTES + 1);
    assert!(shared.dispatch(log(None, 3, huge)).is_err());
    // Within the wire bound but over the message bound: emitted, truncated.
    let long = "y".repeat(MAX_LOG_MESSAGE_BYTES + 10);
    assert!(shared.dispatch(log(None, 3, long)).is_ok());
}

#[test]
fn syscall_denial_reports_are_recorded_with_the_bridge_denials() {
    let shared = shared();
    assert!(shared
        .dispatch(Message::Log(denial_log("socket", 3)))
        .is_ok());
    assert!(shared
        .dispatch(Message::Log(denial_log("connect", 1)))
        .is_ok());
    let denials = shared.bridge.denials();
    assert_eq!(denials.len(), 2);
    assert_eq!(denials[0].operation, "socket");
    assert_eq!(denials[0].reason, super::super::DenialReason::Syscall);
    assert_eq!(denials[0].count, 3);
    assert_eq!(denials[0].session_id, 0);
    assert_eq!(denials[0].plugin_id, "probe");
    assert!(denials[0].target.is_empty());
    assert_eq!(denials[1].operation, "connect");
    assert_eq!(denials[1].count, 1);
}

#[test]
fn malformed_syscall_denial_reports_are_violations() {
    let shared = shared();
    let report = |syscall: &str, count| {
        let mut log = denial_log("socket", 1);
        log.denied = Some(SyscallDenial {
            syscall: syscall.to_owned(),
            count,
        });
        Message::Log(log)
    };
    // Not a reported (trapped) system call: forged by a hostile runner.
    assert!(shared.dispatch(report("execve", 1)).is_err());
    assert!(shared.dispatch(report(&"x".repeat(10_000), 1)).is_err());
    assert!(shared.dispatch(report("socket", 0)).is_err());
    assert!(shared.bridge.denials().is_empty());
    // A known report still needs a valid level.
    let mut bad_level = denial_log("socket", 1);
    bad_level.level = 0;
    assert!(shared.dispatch(Message::Log(bad_level)).is_err());
}

#[test]
fn handshake_frames_after_the_handshake_are_violations() {
    let shared = shared();
    let hello = Message::Hello(Hello {
        runner_version: "x".into(),
        protocol_version: PROTOCOL_VERSION,
        pid: 1,
    });
    assert!(shared.dispatch(hello).is_err());
}

#[test]
fn a_pong_must_answer_a_ping_that_was_sent() {
    let shared = shared();
    // No ping sent yet: any pong is forged.
    assert!(shared
        .dispatch(Message::Pong(Heartbeat { nonce: 1 }))
        .is_err());
    {
        let mut beat = shared.heartbeat.lock().unwrap();
        beat.last_sent = 2;
        beat.outstanding_since = Some(std::time::Instant::now());
    }
    // A stale duplicate is ignored and leaves the ping outstanding.
    assert!(shared
        .dispatch(Message::Pong(Heartbeat { nonce: 1 }))
        .is_ok());
    assert!(shared.heartbeat.lock().unwrap().outstanding_since.is_some());
    // A pong from the future is a violation.
    assert!(shared
        .dispatch(Message::Pong(Heartbeat { nonce: 3 }))
        .is_err());
    // The answer clears it.
    assert!(shared
        .dispatch(Message::Pong(Heartbeat { nonce: 2 }))
        .is_ok());
    assert!(shared.heartbeat.lock().unwrap().outstanding_since.is_none());
}

#[test]
fn the_first_recorded_cause_wins_and_reaches_the_exit_hook() {
    let shared = shared();
    let seen = Arc::new(Mutex::new(None));
    let sink = Arc::clone(&seen);
    shared.set_exit_hook(Box::new(move |cause| {
        *sink.lock().unwrap() = Some(cause.clone());
    }));
    assert_eq!(shared.exit_cause(), None);
    shared.violation("bad frame");
    shared.set_pending_cause(RunnerExitCause::Stopped);
    // Not final until the runner is reaped.
    assert_eq!(shared.exit_cause(), None);
    // Reaping makes it final and runs the hook once.
    shared.finish(None);
    shared.finish(None);
    assert_eq!(
        shared.exit_cause(),
        Some(RunnerExitCause::InvalidData {
            detail: "bad frame".into()
        })
    );
    assert_eq!(seen.lock().unwrap().clone(), shared.exit_cause());
    assert!(shared.dead.load(Ordering::SeqCst));

    // A hook installed after the exit runs at once.
    let late = Arc::new(Mutex::new(None));
    let sink = Arc::clone(&late);
    shared.set_exit_hook(Box::new(move |cause| {
        *sink.lock().unwrap() = Some(cause.clone());
    }));
    assert_eq!(late.lock().unwrap().clone(), shared.exit_cause());
}

#[test]
fn an_unprovoked_exit_is_classified_from_its_status() {
    let shared = shared();
    shared.finish(None);
    assert_eq!(
        shared.exit_cause(),
        Some(RunnerExitCause::Crashed {
            signal: None,
            exit_code: None
        })
    );
}

/// A runner whose memory the host measures as `under_pressure`.
fn measured(under_pressure: bool) -> Arc<Shared> {
    let shared = shared();
    shared.set_memory_probe(Box::new(move || under_pressure));
    shared
}

const ALLOCATION_FAILURE: &[u8] = b"plugin says hi\nmemory allocation of 1048576 bytes failed\n";

/// An exit status: killed by `signal` (Unix), or exit `code` (Windows).
fn status(signal: i32, code: u32) -> std::process::ExitStatus {
    #[cfg(unix)]
    {
        let _ = code;
        std::os::unix::process::ExitStatusExt::from_raw(signal)
    }
    #[cfg(windows)]
    {
        let _ = signal;
        std::os::windows::process::ExitStatusExt::from_raw(code)
    }
}

/// How Rust's allocation-failure handler ends a process.
fn aborted() -> std::process::ExitStatus {
    #[cfg(unix)]
    let signal = libc::SIGABRT;
    #[cfg(not(unix))]
    let signal = 6;
    status(signal, 0xC000_0409)
}

/// How the host's kill ends a process.
fn killed() -> std::process::ExitStatus {
    #[cfg(unix)]
    let signal = libc::SIGKILL;
    #[cfg(not(unix))]
    let signal = 9;
    status(signal, 1)
}

#[test]
fn a_reported_allocation_failure_under_measured_pressure_is_out_of_memory() {
    let shared = measured(true);
    shared.expect_stderr();
    Arc::clone(&shared).forward_stderr(ALLOCATION_FAILURE);
    shared.finish(None);
    assert_eq!(shared.exit_cause(), Some(RunnerExitCause::OutOfMemory));
    assert!(!is_allocation_failure(b"memory allocation of lots"));
    assert!(is_allocation_failure(
        b"memory allocation of 8 bytes failed\r\n"
    ));
}

#[test]
fn a_reported_allocation_failure_followed_by_an_abort_is_out_of_memory() {
    // The runner died before the host could measure it (the usual race
    // under `RLIMIT_AS`), but it ended the way an allocation failure ends.
    let shared = measured(false);
    shared.expect_stderr();
    Arc::clone(&shared).forward_stderr(ALLOCATION_FAILURE);
    shared.finish(Some(aborted()));
    assert_eq!(shared.exit_cause(), Some(RunnerExitCause::OutOfMemory));
}

#[test]
fn a_plugin_written_allocation_failure_alone_does_not_change_the_exit() {
    // #4335 (PLG2-006): the text is the plugin's; without host-side evidence
    // the exit keeps the classification its status gives it.
    let shared = measured(false);
    shared.expect_stderr();
    Arc::clone(&shared).forward_stderr(ALLOCATION_FAILURE);
    shared.finish(Some(killed()));
    assert!(
        matches!(shared.exit_cause(), Some(RunnerExitCause::Crashed { .. })),
        "{:?}",
        shared.exit_cause()
    );

    // No probe at all (nothing measurable) and no status: still a crash.
    let unmeasured = self::shared();
    unmeasured.expect_stderr();
    Arc::clone(&unmeasured).forward_stderr(ALLOCATION_FAILURE);
    unmeasured.finish(None);
    assert!(matches!(
        unmeasured.exit_cause(),
        Some(RunnerExitCause::Crashed { .. })
    ));
}

#[test]
fn a_hung_plugin_cannot_disguise_its_hang_as_out_of_memory() {
    let shared = measured(false);
    shared.expect_stderr();
    shared.set_pending_cause(RunnerExitCause::NotResponding);
    Arc::clone(&shared).forward_stderr(ALLOCATION_FAILURE);
    // The host's kill ended it, not an abort.
    shared.finish(Some(killed()));
    assert_eq!(shared.exit_cause(), Some(RunnerExitCause::NotResponding));
}

#[test]
fn ended_by_abort_recognises_only_an_abort() {
    assert!(ended_by_abort(aborted()));
    assert!(!ended_by_abort(killed()));
}

/// One captured `tracing` event: its level and message.
#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<(tracing::Level, String)>>>);

struct MessageVisitor(String);

impl tracing::field::Visit for MessageVisitor {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.0 = format!("{value:?}");
        }
    }
}

impl tracing::Subscriber for Capture {
    fn enabled(&self, _: &tracing::Metadata<'_>) -> bool {
        true
    }
    fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(1)
    }
    fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
    fn event(&self, event: &tracing::Event<'_>) {
        let mut visitor = MessageVisitor(String::new());
        event.record(&mut visitor);
        self.0
            .lock()
            .unwrap()
            .push((*event.metadata().level(), visitor.0));
    }
    fn enter(&self, _: &tracing::span::Id) {}
    fn exit(&self, _: &tracing::span::Id) {}
}

#[test]
fn stderr_lines_go_through_the_log_limiter_tagged_and_sanitised() {
    use crate::plugin::log_rate_limit::LogRateLimitConfig;

    let limiter = Arc::new(PluginLogLimiter::new(LogRateLimitConfig {
        burst: 2,
        lines_per_sec: 1,
        summary_interval: std::time::Duration::from_secs(3600),
    }));
    let shared = Shared::new("probe".to_owned(), None, Arc::clone(&limiter));
    shared.expect_stderr();
    let capture = Capture::default();
    let stderr = b"\x1b]0;owned\x07evil\r\x1b[2Jline\nsecond\nthird\nfourth\n";
    tracing::subscriber::with_default(capture.clone(), || {
        Arc::clone(&shared).forward_stderr(&stderr[..]);
    });
    let events = capture.0.lock().unwrap().clone();
    // The burst of two lines is emitted at warn level, tagged with the
    // host-trusted id, every control character turned into a space.
    assert_eq!(
        events,
        [
            (
                tracing::Level::WARN,
                "[probe]  ]0;owned evil  [2Jline".to_owned()
            ),
            (tracing::Level::WARN, "[probe] second".to_owned()),
        ]
    );
    // The rest was dropped by the limiter, not written anywhere.
    assert_eq!(limiter.pending_suppressed(), 2);
}

#[test]
fn an_overlong_stderr_line_is_bounded_and_marked_truncated() {
    let shared = shared();
    shared.expect_stderr();
    let capture = Capture::default();
    let mut long = vec![b'x'; MAX_LOG_MESSAGE_BYTES + 100];
    long.push(b'\n');
    tracing::subscriber::with_default(capture.clone(), || {
        Arc::clone(&shared).forward_stderr(&long[..]);
    });
    let events = capture.0.lock().unwrap().clone();
    assert_eq!(events.len(), 1, "one bounded line");
    let (_, line) = &events[0];
    assert!(line.ends_with("…[truncated]"), "{line}");
    assert!(line.len() < MAX_LOG_MESSAGE_BYTES + 64, "{}", line.len());
}

#[test]
fn marking_dead_ends_every_session_and_releases_waiters() {
    let shared = shared();
    let (id, alive, mut rx) = register(&shared);
    let (tx, reply) = std::sync::mpsc::sync_channel(1);
    shared.sessions.lock().unwrap().get_mut(&id).unwrap().reply = Some(tx);
    shared.mark_dead("test");
    assert!(!alive.load(Ordering::SeqCst));
    assert!(matches!(
        reply.try_recv(),
        Ok(Reply::Failed(PluginError::NotAlive))
    ));
    // The output sender was dropped: the stream ends.
    assert!(rx.try_recv().is_err());
    assert!(rx.is_closed());
}

#[test]
fn a_vanished_runner_is_an_exit_not_invalid_data() {
    use std::io::{Error, ErrorKind};
    assert!(runner_went_away(&ProtocolError::Io(Error::from(
        ErrorKind::ConnectionReset
    ))));
    assert!(runner_went_away(&ProtocolError::Truncated));
    assert!(!runner_went_away(&ProtocolError::UnknownKind(0xEE)));
    assert!(!runner_went_away(&ProtocolError::FrameTooLarge(1 << 30)));
}

#[test]
fn out_of_memory_evidence_beats_a_racing_hang_verdict() {
    // #4239: the watchdog declared a hang, but the runner reported a failed
    // allocation before it went: the overlay must say out of memory.
    let shared = measured(true);
    shared.expect_stderr();
    shared.set_pending_cause(RunnerExitCause::NotResponding);
    Arc::clone(&shared).forward_stderr(&b"memory allocation of 1048576 bytes failed\n"[..]);
    shared.finish(Some(killed()));
    assert_eq!(shared.exit_cause(), Some(RunnerExitCause::OutOfMemory));

    // Without the evidence the hang stands.
    let hung = self::shared();
    hung.set_pending_cause(RunnerExitCause::NotResponding);
    hung.finish(None);
    assert_eq!(hung.exit_cause(), Some(RunnerExitCause::NotResponding));

    // Only a hang gives way: a violation or a host stop keeps its cause.
    assert_eq!(
        prefer_memory_evidence(RunnerExitCause::Stopped, true),
        RunnerExitCause::Stopped
    );
    assert!(matches!(
        prefer_memory_evidence(RunnerExitCause::InvalidData { detail: "x".into() }, true),
        RunnerExitCause::InvalidData { .. }
    ));
}

#[test]
fn output_beyond_the_rate_cap_across_sessions_is_a_violation() {
    let shared = shared();
    // A rate far below what the test can produce: only the burst counts.
    shared.set_output_rate_cap(OutputRateCap {
        bytes_per_second: 1,
        burst_bytes: 1000,
    });
    let (a, _alive_a, _rx_a) = register(&shared);
    let (b, _alive_b, _rx_b) = register(&shared);
    let output = |session_id, len| Message::Output {
        session_id,
        data: vec![b'x'; len],
    };
    // The cap is per runner: two sessions share one budget.
    shared.dispatch(output(a, 600)).unwrap();
    shared.dispatch(output(b, 400)).unwrap();
    let err = shared.dispatch(output(b, 10)).unwrap_err();
    assert!(err.contains("output rate cap"), "{err}");
}

#[test]
fn undelivered_output_counts_against_the_cap() {
    let shared = shared();
    shared.set_output_rate_cap(OutputRateCap {
        bytes_per_second: 1,
        burst_bytes: 100,
    });
    // A retired session's late output is dropped, but still metered: a
    // runner cannot flood the host through a session nobody reads.
    let (id, _alive, _rx) = register(&shared);
    shared.retire(id);
    let flood = || Message::Output {
        session_id: id,
        data: vec![0; 60],
    };
    shared.dispatch(flood()).unwrap();
    assert!(shared.dispatch(flood()).is_err());
}

#[test]
fn the_default_cap_lets_a_large_burst_through() {
    let shared = shared();
    let (id, _alive, mut rx) = register(&shared);
    // 64 MiB at once (the perf gate's 256 MiB run is chunked the same way).
    for _ in 0..1024 {
        shared
            .dispatch(Message::Output {
                session_id: id,
                data: vec![0; 64 * 1024],
            })
            .unwrap();
        let _ = rx.try_recv();
    }
}
