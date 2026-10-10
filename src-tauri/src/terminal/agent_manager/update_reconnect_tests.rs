//! Tests for the backend-driven coordinated-update reconnect (#4489).
//!
//! Every timing test runs on paused tokio time, so the restart window, the
//! backoff and the deadline are asserted exactly without real waiting.

use std::sync::atomic::{AtomicU32, Ordering};

use serde_json::Value;
use tauri::Listener;
use tokio::time::Instant;

use super::*;
use crate::terminal::agent_manager::tests::make_agent_connection;

/// A jitter source that never shortens a window: the nominal schedule.
fn no_jitter() -> f64 {
    0.0
}

fn capabilities(agent_version: &str) -> AgentCapabilities {
    let mut caps = make_agent_connection(true).capabilities.get();
    caps.agent_version = agent_version.to_string();
    caps
}

// ── The reconnect loop ───────────────────────────────────────────────

#[test]
fn initial_delay_is_the_restart_estimate_plus_the_buffer() {
    assert_eq!(update_reconnect_initial_delay(5), Duration::from_secs(8));
    // A zero estimate still waits a second for the agent to start restarting.
    assert_eq!(update_reconnect_initial_delay(0), Duration::from_secs(4));
}

#[tokio::test(start_paused = true)]
async fn first_attempt_waits_the_restart_window() {
    let start = Instant::now();
    let cancel = CancellationToken::new();
    let mut rand = no_jitter;
    let at = Arc::new(Mutex::new(Vec::new()));
    let at_c = Arc::clone(&at);
    let outcome = drive_update_reconnect(
        Duration::from_secs(8),
        AGENT_UPDATE_RECONNECT_DEADLINE,
        &cancel,
        &mut rand,
        || {
            at_c.lock().unwrap().push(start.elapsed());
            async { Ok::<_, String>("caps") }
        },
    )
    .await;
    assert_eq!(
        outcome,
        DriveOutcome::Reconnected {
            value: "caps",
            attempts: 1
        }
    );
    assert_eq!(*at.lock().unwrap(), vec![Duration::from_secs(8)]);
}

/// Failed attempts back off on the shared policy's windows (2, 4, 8 s at no
/// jitter) after the restart window, until one succeeds.
#[tokio::test(start_paused = true)]
async fn failures_back_off_on_the_shared_policy() {
    let start = Instant::now();
    let cancel = CancellationToken::new();
    let mut rand = no_jitter;
    let at = Arc::new(Mutex::new(Vec::new()));
    let at_c = Arc::clone(&at);
    let outcome = drive_update_reconnect(
        Duration::from_secs(8),
        AGENT_UPDATE_RECONNECT_DEADLINE,
        &cancel,
        &mut rand,
        || {
            let mut at = at_c.lock().unwrap();
            at.push(start.elapsed().as_secs());
            let n = at.len();
            async move {
                if n < 4 {
                    Err(format!("refused {n}"))
                } else {
                    Ok(())
                }
            }
        },
    )
    .await;
    assert_eq!(
        outcome,
        DriveOutcome::Reconnected {
            value: (),
            attempts: 4
        }
    );
    assert_eq!(*at.lock().unwrap(), vec![8, 10, 14, 22]);
}

/// The deadline bounds the loop: the last wait is clipped so the final attempt
/// lands on the deadline, and its failure gives up with the last error.
#[tokio::test(start_paused = true)]
async fn gives_up_at_the_deadline_with_the_last_error() {
    let start = Instant::now();
    let cancel = CancellationToken::new();
    let mut rand = no_jitter;
    let at = Arc::new(Mutex::new(Vec::new()));
    let at_c = Arc::clone(&at);
    let outcome: DriveOutcome<()> = drive_update_reconnect(
        Duration::from_secs(8),
        AGENT_UPDATE_RECONNECT_DEADLINE,
        &cancel,
        &mut rand,
        || {
            let mut at = at_c.lock().unwrap();
            at.push(start.elapsed().as_secs());
            let n = at.len();
            async move { Err(format!("refused {n}")) }
        },
    )
    .await;
    // 8 s restart window, then 2, 4, 8, 16, 30, 30 s, and the 30 s window
    // after 98 s clipped to the 120 s deadline.
    assert_eq!(*at.lock().unwrap(), vec![8, 10, 14, 22, 38, 68, 98, 120]);
    assert_eq!(
        outcome,
        DriveOutcome::GaveUp {
            attempts: 8,
            error: "refused 8".to_string()
        }
    );
    assert_eq!(start.elapsed(), AGENT_UPDATE_RECONNECT_DEADLINE);
}

/// With a deadline longer than the policy's whole schedule, the policy's
/// attempt budget ends the loop.
#[tokio::test(start_paused = true)]
async fn gives_up_when_the_policy_budget_is_spent() {
    let cancel = CancellationToken::new();
    let mut rand = no_jitter;
    let calls = Arc::new(AtomicU32::new(0));
    let calls_c = Arc::clone(&calls);
    let outcome: DriveOutcome<()> = drive_update_reconnect(
        Duration::from_secs(1),
        Duration::from_secs(3_600),
        &cancel,
        &mut rand,
        || {
            calls_c.fetch_add(1, Ordering::SeqCst);
            async { Err("refused".to_string()) }
        },
    )
    .await;
    let budget = RECONNECT_POLICY.max_attempts as u32;
    assert_eq!(
        outcome,
        DriveOutcome::GaveUp {
            attempts: budget,
            error: "refused".to_string()
        }
    );
    assert_eq!(calls.load(Ordering::SeqCst), budget);
}

#[tokio::test(start_paused = true)]
async fn the_restart_window_is_clipped_to_the_deadline() {
    let start = Instant::now();
    let cancel = CancellationToken::new();
    let mut rand = no_jitter;
    let outcome: DriveOutcome<()> = drive_update_reconnect(
        Duration::from_secs(300),
        Duration::from_secs(60),
        &cancel,
        &mut rand,
        || async { Err("refused".to_string()) },
    )
    .await;
    assert_eq!(
        outcome,
        DriveOutcome::GaveUp {
            attempts: 1,
            error: "refused".to_string()
        }
    );
    assert_eq!(start.elapsed(), Duration::from_secs(60));
}

/// A cancel during the restart window stops the loop at that instant, before
/// any attempt.
#[tokio::test(start_paused = true)]
async fn cancel_in_the_restart_window_stops_without_an_attempt() {
    let start = Instant::now();
    let cancel = CancellationToken::new();
    let canceller = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(3)).await;
        canceller.cancel();
    });
    let mut rand = no_jitter;
    let calls = Arc::new(AtomicU32::new(0));
    let calls_c = Arc::clone(&calls);
    let outcome: DriveOutcome<()> = drive_update_reconnect(
        Duration::from_secs(8),
        AGENT_UPDATE_RECONNECT_DEADLINE,
        &cancel,
        &mut rand,
        || {
            calls_c.fetch_add(1, Ordering::SeqCst);
            async { Ok(()) }
        },
    )
    .await;
    assert_eq!(outcome, DriveOutcome::Stopped { attempts: 0 });
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(start.elapsed(), Duration::from_secs(3));
}

/// A cancel during a hung attempt drops it at once.
#[tokio::test(start_paused = true)]
async fn cancel_during_an_attempt_drops_it() {
    let start = Instant::now();
    let cancel = CancellationToken::new();
    let canceller = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(20)).await;
        canceller.cancel();
    });
    let mut rand = no_jitter;
    let outcome: DriveOutcome<()> = drive_update_reconnect(
        Duration::from_secs(8),
        AGENT_UPDATE_RECONNECT_DEADLINE,
        &cancel,
        &mut rand,
        std::future::pending::<Result<(), String>>,
    )
    .await;
    assert_eq!(outcome, DriveOutcome::Stopped { attempts: 1 });
    assert_eq!(start.elapsed(), Duration::from_secs(20));
}

// ── The registry ─────────────────────────────────────────────────────

#[test]
fn registry_ignores_a_duplicate_notice_and_replaces_an_older_update() {
    let registry = UpdateReconnectRegistry::default();
    let first = registry.begin("agent-1", "1.4.0").expect("first notice");
    assert!(registry.begin("agent-1", "1.4.0").is_none(), "duplicate");
    assert!(!first.token.is_cancelled());

    let second = registry.begin("agent-1", "1.5.0").expect("newer update");
    assert!(first.token.is_cancelled());
    assert_eq!(first.stop_reason(), UpdateReconnectStop::Replaced);

    // The replaced reconnect finishing late leaves its successor in place.
    registry.finish("agent-1", first.generation);
    assert!(registry.is_active("agent-1"));
    registry.finish("agent-1", second.generation);
    assert!(!registry.is_active("agent-1"));
}

#[test]
fn registry_stop_records_the_reason() {
    let registry = UpdateReconnectRegistry::default();
    assert!(registry
        .stop("agent-1", UpdateReconnectStop::Cancelled)
        .is_none());
    let ticket = registry.begin("agent-1", "1.4.0").unwrap();
    let stopped = registry
        .stop("agent-1", UpdateReconnectStop::Superseded)
        .unwrap();
    assert!(ticket.token.is_cancelled());
    assert_eq!(stopped.stop_reason(), UpdateReconnectStop::Superseded);
    assert!(!registry.is_active("agent-1"));
}

// ── The manager's update-suspend path ────────────────────────────────

/// Events the manager emitted, as `(event name, payload)`.
type EventLog = Arc<Mutex<Vec<(String, Value)>>>;

struct Harness {
    _app: tauri::App<tauri::test::MockRuntime>,
    manager: Arc<AgentConnectionManager<tauri::test::MockRuntime>>,
    events: EventLog,
}

/// A manager with a live `agent-1` connection whose reattach config is also
/// retained for a resilient tab, recording the update events it emits.
fn harness() -> Harness {
    let app = tauri::test::mock_app();
    let manager = Arc::new(AgentConnectionManager::new(app.handle().clone()));
    manager
        .agents
        .lock()
        .unwrap()
        .insert("agent-1".to_string(), make_agent_connection(true));
    assert!(manager.retain_agent_config("agent-1"));
    let events: EventLog = Arc::default();
    for name in ["remote-agent-update-pending", "agent-update-reconnect"] {
        let log = Arc::clone(&events);
        app.handle().listen_any(name, move |event| {
            let payload: Value = serde_json::from_str(event.payload()).unwrap();
            log.lock().unwrap().push((name.to_string(), payload));
        });
    }
    Harness {
        _app: app,
        manager,
        events,
    }
}

impl Harness {
    fn outcomes(&self) -> Vec<Value> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(name, _)| name == "agent-update-reconnect")
            .map(|(_, payload)| payload.clone())
            .collect()
    }

    fn notices(&self) -> usize {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(name, _)| name == "remote-agent-update-pending")
            .count()
    }
}

/// The update suspend tears the connection down but keeps the transport
/// config, reconnects with it after the restart window, and reports the
/// reconnected agent's version once to every window.
#[tokio::test(start_paused = true)]
async fn update_suspend_keeps_the_config_and_reconnects_once() {
    let h = harness();
    let start = Instant::now();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seen_c = Arc::clone(&seen);
    assert!(h.manager.begin_update_reconnect_with(
        "agent-1",
        "1.4.0",
        5,
        move |agent_id, retained| {
            seen_c.lock().unwrap().push((
                agent_id,
                retained.config.password.clone(),
                start.elapsed(),
            ));
            async { Ok(Some(capabilities("1.4.0"))) }
        }
    ));
    // The waiting notice goes out at once, before anything else.
    assert_eq!(h.notices(), 1);
    // A duplicate notice for the same update starts nothing.
    assert!(!h
        .manager
        .begin_update_reconnect_with("agent-1", "1.4.0", 5, |_, _| async { Ok(None) }));
    assert_eq!(h.notices(), 1);

    tokio::time::sleep(Duration::from_secs(1)).await;
    // Suspended: the connection is gone, its reattach config is kept.
    assert!(!h.manager.is_connected("agent-1"));
    assert!(h.manager.has_retained_agent_config("agent-1"));
    assert!(h.outcomes().is_empty());

    tokio::time::sleep(Duration::from_secs(10)).await;
    assert_eq!(
        *seen.lock().unwrap(),
        vec![(
            "agent-1".to_string(),
            Some("secret".to_string()),
            Duration::from_secs(8)
        )]
    );
    assert_eq!(
        h.outcomes(),
        vec![serde_json::json!({
            "agentId": "agent-1",
            "requestedByVersion": "1.4.0",
            "outcome": "reconnected",
            "attempts": 1,
            "agentVersion": "1.4.0",
        })]
    );
    assert!(!h.manager.update_reconnects.is_active("agent-1"));
}

#[tokio::test(start_paused = true)]
async fn deadline_give_up_reports_failed_with_the_last_error() {
    let h = harness();
    let calls = Arc::new(AtomicU32::new(0));
    let calls_c = Arc::clone(&calls);
    h.manager
        .begin_update_reconnect_with("agent-1", "1.4.0", 5, move |_, _| {
            let n = calls_c.fetch_add(1, Ordering::SeqCst) + 1;
            async move { Err(format!("connection refused ({n})")) }
        });
    tokio::time::sleep(AGENT_UPDATE_RECONNECT_DEADLINE + Duration::from_secs(5)).await;
    let outcomes = h.outcomes();
    assert_eq!(outcomes.len(), 1);
    let n = calls.load(Ordering::SeqCst);
    assert!(n >= 2, "retried before giving up, made {n} attempts");
    assert_eq!(outcomes[0]["outcome"], "failed");
    assert_eq!(outcomes[0]["attempts"], n);
    assert_eq!(
        outcomes[0]["error"],
        format!("connection refused ({n})").as_str()
    );
    assert!(outcomes[0].get("agentVersion").is_none());
}

#[tokio::test(start_paused = true)]
async fn user_cancel_reports_cancelled_and_never_attempts() {
    let h = harness();
    let calls = Arc::new(AtomicU32::new(0));
    let calls_c = Arc::clone(&calls);
    h.manager
        .begin_update_reconnect_with("agent-1", "1.4.0", 5, move |_, _| {
            calls_c.fetch_add(1, Ordering::SeqCst);
            async { Ok(None) }
        });
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(h.manager.cancel_update_reconnect("agent-1", false));
    assert!(!h.manager.cancel_update_reconnect("agent-1", false));
    tokio::time::sleep(Duration::from_secs(30)).await;
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let outcomes = h.outcomes();
    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0]["outcome"], "cancelled");
    assert_eq!(outcomes[0]["attempts"], 0);
}

/// A user Disconnect while the backend waits for the agent supersedes the
/// reconnect: no attempt, and the windows drop the notice.
#[tokio::test(start_paused = true)]
async fn a_disconnect_supersedes_the_update_reconnect() {
    let h = harness();
    let calls = Arc::new(AtomicU32::new(0));
    let calls_c = Arc::clone(&calls);
    h.manager
        .begin_update_reconnect_with("agent-1", "1.4.0", 5, move |_, _| {
            calls_c.fetch_add(1, Ordering::SeqCst);
            async { Ok(None) }
        });
    tokio::time::sleep(Duration::from_secs(2)).await;
    // The suspended agent is already disconnected, so the call itself reports
    // "not connected" — but the reconnect is superseded either way.
    let _ = h.manager.disconnect_agent("agent-1");
    tokio::time::sleep(Duration::from_secs(30)).await;
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let outcomes = h.outcomes();
    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0]["outcome"], "superseded");
    // A user end scrubs the kept config.
    assert!(!h.manager.has_retained_agent_config("agent-1"));
}

/// A notice for a newer update replaces the running reconnect silently: one
/// notice per update, one outcome in total.
#[tokio::test(start_paused = true)]
async fn a_newer_update_replaces_the_running_reconnect() {
    let h = harness();
    h.manager
        .begin_update_reconnect_with("agent-1", "1.4.0", 5, |_, _| async {
            Ok(Some(capabilities("1.4.0")))
        });
    tokio::time::sleep(Duration::from_secs(2)).await;
    // The connection was suspended by the first reconnect; put a fresh one in
    // place, as if the agent had reconnected and been notified again.
    h.manager
        .agents
        .lock()
        .unwrap()
        .insert("agent-1".to_string(), make_agent_connection(true));
    h.manager
        .begin_update_reconnect_with("agent-1", "1.5.0", 5, |_, _| async {
            Ok(Some(capabilities("1.5.0")))
        });
    tokio::time::sleep(Duration::from_secs(30)).await;
    assert_eq!(h.notices(), 2);
    let outcomes = h.outcomes();
    assert_eq!(outcomes.len(), 1, "{outcomes:?}");
    assert_eq!(outcomes[0]["requestedByVersion"], "1.5.0");
    assert_eq!(outcomes[0]["agentVersion"], "1.5.0");
}

#[tokio::test(start_paused = true)]
async fn no_live_connection_to_suspend_reports_failed() {
    let h = harness();
    h.manager.agents.lock().unwrap().clear();
    h.manager
        .begin_update_reconnect_with("agent-1", "1.4.0", 5, |_, _| async { Ok(None) });
    tokio::time::sleep(Duration::from_secs(1)).await;
    let outcomes = h.outcomes();
    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0]["outcome"], "failed");
    assert_eq!(outcomes[0]["attempts"], 0);
    assert!(!h.manager.update_reconnects.is_active("agent-1"));
}

// ── A manual connect during an attempt (#4621) ───────────────────────

/// A boxed update-reconnect attempt future.
type AttemptFuture =
    std::pin::Pin<Box<dyn Future<Output = Result<Option<AgentCapabilities>, String>> + Send>>;

/// A scripted, slow connect attempt that holds the agent's real connect
/// reservation, as the agent's own connect does: it takes 60 s, unless its
/// connect is cancelled, which aborts it at once.
fn slow_reserving_attempt(
    manager: &Arc<AgentConnectionManager<tauri::test::MockRuntime>>,
) -> impl Fn(String, RetainedAgentConfig) -> AttemptFuture + Send + Sync + 'static {
    let manager = Arc::clone(manager);
    move |agent_id, _| {
        let manager = Arc::clone(&manager);
        Box::pin(async move {
            let cancel = CancellationToken::new();
            let _reservation = manager
                .reserve_connect(&agent_id, &cancel)
                .map_err(|e| e.to_string())?;
            tokio::select! {
                _ = cancel.cancelled() => Err("Connect cancelled".to_string()),
                _ = tokio::time::sleep(Duration::from_secs(60)) => {
                    Ok(Some(capabilities("1.4.0")))
                }
            }
        })
    }
}

/// A manual connect while an update-reconnect attempt is in flight takes the
/// agent over at once: the attempt is cancelled and its reservation released
/// before the manual connect reserves the agent, which then connects with no
/// "already connecting" refusal.
#[tokio::test(start_paused = true)]
async fn a_manual_connect_takes_over_an_attempt_in_flight() {
    let h = harness();
    let attempt = slow_reserving_attempt(&h.manager);
    assert!(h
        .manager
        .begin_update_reconnect_with("agent-1", "1.4.0", 5, attempt));
    // Past the 8 s restart window: the first attempt holds the reservation.
    tokio::time::sleep(Duration::from_secs(10)).await;
    assert!(h.manager.connecting.lock().unwrap().contains_key("agent-1"));

    let start = Instant::now();
    let rpc: &dyn AgentRpcClient = h.manager.as_ref();
    await_update_reconnect_takeover(rpc, "agent-1").await;
    // The cancelled attempt settled at once, not after its 60 s.
    assert_eq!(start.elapsed(), Duration::ZERO);

    // The manual connect's own reservation succeeds, and it connects.
    let reservation = h
        .manager
        .reserve_connect("agent-1", &CancellationToken::new())
        .expect("the manual connect is not refused as already connecting");
    h.manager
        .agents
        .lock()
        .unwrap()
        .insert("agent-1".to_string(), make_agent_connection(true));
    drop(reservation);
    assert!(h.manager.is_connected("agent-1"));

    // The backend reconnect never comes back over it, and the windows drop
    // the notice quietly.
    tokio::time::sleep(AGENT_UPDATE_RECONNECT_DEADLINE).await;
    assert!(h.manager.is_connected("agent-1"));
    let outcomes = h.outcomes();
    assert_eq!(outcomes.len(), 1, "{outcomes:?}");
    assert_eq!(outcomes[0]["outcome"], "superseded");
    assert_eq!(outcomes[0]["attempts"], 1);
    assert!(!h.manager.update_reconnects.is_active("agent-1"));
}

/// Waiting between attempts there is nothing to settle: the takeover returns
/// at once and the manual connect reserves the agent.
#[tokio::test(start_paused = true)]
async fn a_manual_connect_in_the_restart_window_takes_over_at_once() {
    let h = harness();
    let attempt = slow_reserving_attempt(&h.manager);
    h.manager
        .begin_update_reconnect_with("agent-1", "1.4.0", 5, attempt);
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(h.manager.take_over_update_reconnect("agent-1").is_none());
    assert!(h
        .manager
        .reserve_connect("agent-1", &CancellationToken::new())
        .is_ok());
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(h.outcomes()[0]["outcome"], "superseded");
    assert_eq!(h.outcomes()[0]["attempts"], 0);
}

/// The user's Cancel still aborts an attempt in flight at once and releases
/// its reservation.
#[tokio::test(start_paused = true)]
async fn user_cancel_aborts_an_attempt_in_flight() {
    let h = harness();
    let attempt = slow_reserving_attempt(&h.manager);
    h.manager
        .begin_update_reconnect_with("agent-1", "1.4.0", 5, attempt);
    tokio::time::sleep(Duration::from_secs(10)).await;
    assert!(h.manager.connecting.lock().unwrap().contains_key("agent-1"));
    assert!(h.manager.cancel_update_reconnect("agent-1", false));
    tokio::time::sleep(Duration::from_millis(1)).await;
    assert!(!h.manager.connecting.lock().unwrap().contains_key("agent-1"));
    let outcomes = h.outcomes();
    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0]["outcome"], "cancelled");
    assert_eq!(outcomes[0]["attempts"], 1);
}
