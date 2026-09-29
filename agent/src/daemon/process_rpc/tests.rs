//! Process list + kill over the session-daemon frame protocol (#3210).

use super::*;
use std::sync::Mutex as StdMutex;

/// Records every kill and answers a fixed table / kill outcome.
struct FakeManager {
    processes: Vec<ProcessInfo>,
    kill_result: Result<(), ProcessError>,
    kills: StdMutex<Vec<(u32, KillSignal)>>,
}

impl FakeManager {
    fn new() -> Self {
        Self {
            processes: vec![process(42, "sleep")],
            kill_result: Ok(()),
            kills: StdMutex::new(Vec::new()),
        }
    }
}

#[async_trait::async_trait]
impl ProcessManager for FakeManager {
    async fn list_processes(&self) -> Result<Vec<ProcessInfo>, ProcessError> {
        Ok(self.processes.clone())
    }

    async fn kill_process(&self, pid: u32, signal: KillSignal) -> Result<(), ProcessError> {
        self.kills.lock().unwrap().push((pid, signal));
        self.kill_result.clone()
    }
}

fn process(pid: u32, name: &str) -> ProcessInfo {
    ProcessInfo {
        pid,
        name: name.to_string(),
        user: "alice".to_string(),
        cpu_percent: 1.5,
        memory_percent: 0.5,
        memory_kb: None,
    }
}

// ── Wire shapes ─────────────────────────────────────────────────────

#[test]
fn list_request_wire_shape() {
    let req = ProcessRequest {
        id: 1,
        op: ProcessOp::List,
    };
    let v = serde_json::to_value(&req).unwrap();
    assert_eq!(v, serde_json::json!({ "id": 1, "op": "list" }));
    let back: ProcessRequest = serde_json::from_value(v).unwrap();
    assert_eq!(back, req);
}

#[test]
fn kill_request_wire_shape_carries_pid_and_signal() {
    let req = ProcessRequest {
        id: 7,
        op: ProcessOp::Kill {
            pid: 42,
            signal: KillSignal::Usr1,
        },
    };
    let v = serde_json::to_value(&req).unwrap();
    assert_eq!(
        v,
        serde_json::json!({ "id": 7, "op": "kill", "pid": 42, "signal": "usr1" })
    );
    let back: ProcessRequest = serde_json::from_value(v).unwrap();
    assert_eq!(back, req);
}

#[test]
fn response_round_trips_each_outcome() {
    for outcome in [
        ProcessOutcome::Listed {
            processes: vec![process(1, "init")],
        },
        ProcessOutcome::Killed,
        ProcessOutcome::Failed {
            error: WireProcessError::NotFound { pid: 9 },
        },
    ] {
        let resp = ProcessResponse { id: 3, outcome };
        let bytes = serde_json::to_vec(&resp).unwrap();
        let back: ProcessResponse = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back, resp);
    }
}

/// Every typed [`ProcessError`] survives the daemon hop unchanged, so the
/// desktop sees the same error for an agent-hosted session as for a direct one.
#[test]
fn every_process_error_survives_the_wire() {
    let errors = [
        ProcessError::NotSupported,
        ProcessError::NotFound(12),
        ProcessError::PermissionDenied("operation not permitted".into()),
        ProcessError::ListFailed("ps missing".into()),
        ProcessError::UnsupportedSignal {
            signal: KillSignal::Stop,
            reason: "kill: invalid signal".into(),
        },
        ProcessError::KillFailed {
            pid: 5,
            message: "boom".into(),
        },
        ProcessError::AgentOutdated,
    ];
    for error in errors {
        let wire = WireProcessError::from(error.clone());
        let bytes = serde_json::to_vec(&wire).unwrap();
        let back: WireProcessError = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(ProcessError::from(back), error);
    }
}

// ── Daemon side ─────────────────────────────────────────────────────

#[tokio::test]
async fn serve_lists_through_the_sessions_manager() {
    let manager: Arc<dyn ProcessManager + Send + Sync> = Arc::new(FakeManager::new());
    let outcome = serve(Some(&manager), ProcessOp::List).await;
    assert_eq!(
        outcome,
        ProcessOutcome::Listed {
            processes: vec![process(42, "sleep")]
        }
    );
}

#[tokio::test]
async fn serve_kills_the_exact_pid_with_the_chosen_signal() {
    let fake = Arc::new(FakeManager::new());
    let manager: Arc<dyn ProcessManager + Send + Sync> = fake.clone();
    let outcome = serve(
        Some(&manager),
        ProcessOp::Kill {
            pid: 42,
            signal: KillSignal::Hup,
        },
    )
    .await;
    assert_eq!(outcome, ProcessOutcome::Killed);
    assert_eq!(*fake.kills.lock().unwrap(), vec![(42, KillSignal::Hup)]);
}

#[tokio::test]
async fn serve_reports_an_unsupported_signal() {
    let mut fake = FakeManager::new();
    fake.kill_result = Err(ProcessError::UnsupportedSignal {
        signal: KillSignal::Usr2,
        reason: "kill: invalid signal".into(),
    });
    let manager: Arc<dyn ProcessManager + Send + Sync> = Arc::new(fake);
    let outcome = serve(
        Some(&manager),
        ProcessOp::Kill {
            pid: 1,
            signal: KillSignal::Usr2,
        },
    )
    .await;
    assert_eq!(
        outcome,
        ProcessOutcome::Failed {
            error: WireProcessError::UnsupportedSignal {
                signal: KillSignal::Usr2,
                reason: "kill: invalid signal".into(),
            }
        }
    );
}

#[tokio::test]
async fn serve_without_a_manager_is_not_supported() {
    let outcome = serve(None, ProcessOp::List).await;
    assert_eq!(
        outcome,
        ProcessOutcome::Failed {
            error: WireProcessError::NotSupported
        }
    );
}

// ── Agent side: reply routing ───────────────────────────────────────

#[tokio::test]
async fn channel_routes_a_reply_to_its_request_only() {
    let channel = ProcessChannel::default();
    let (first, rx_first) = channel.register();
    let (second, rx_second) = channel.register();
    assert_ne!(first, second);

    let reply = ProcessResponse {
        id: second,
        outcome: ProcessOutcome::Killed,
    };
    channel.deliver(&serde_json::to_vec(&reply).unwrap());

    assert_eq!(rx_second.await.unwrap(), ProcessOutcome::Killed);
    // The other request is still pending.
    assert_eq!(channel.pending_len(), 1);
    drop(rx_first);
}

#[test]
fn channel_ignores_malformed_and_unknown_replies() {
    let channel = ProcessChannel::default();
    let (_id, _rx) = channel.register();
    channel.deliver(b"not json");
    let stray = ProcessResponse {
        id: 999,
        outcome: ProcessOutcome::Killed,
    };
    channel.deliver(&serde_json::to_vec(&stray).unwrap());
    assert_eq!(channel.pending_len(), 1);
}

#[tokio::test]
async fn fail_all_releases_every_waiter() {
    let channel = ProcessChannel::default();
    let (_a, rx_a) = channel.register();
    let (_b, rx_b) = channel.register();
    channel.fail_all();
    assert!(rx_a.await.is_err());
    assert!(rx_b.await.is_err());
    assert_eq!(channel.pending_len(), 0);
}

#[test]
fn support_flag_defaults_off() {
    let channel = ProcessChannel::default();
    assert!(!channel.supported());
    channel.set_supported(true);
    assert!(channel.supported());
}

/// A manager whose daemon connection is gone fails honestly instead of hanging.
#[tokio::test]
async fn a_detached_writer_fails_list_and_kill() {
    let writer: crate::daemon::client::DaemonWriterHandle = Arc::new(tokio::sync::Mutex::new(None));
    let manager = DaemonProcessManager::new(writer, Arc::new(ProcessChannel::default()));
    assert!(matches!(
        manager.list_processes().await,
        Err(ProcessError::ListFailed(_))
    ));
    assert!(matches!(
        manager.kill_process(1, KillSignal::Term).await,
        Err(ProcessError::KillFailed { pid: 1, .. })
    ));
}
