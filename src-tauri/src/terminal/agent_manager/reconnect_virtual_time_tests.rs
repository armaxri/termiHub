//! The in-task agent reconnect's backoff, park and give-up timing, graded in
//! virtual time (#5339).
//!
//! [`reconnect_agent`] runs here on the production policy without jitter and a
//! [`VirtualBackoffClock`], against a dead loopback endpoint (or the
//! in-process [`FakeAgentSshd`] brought back on it). Every connect attempt is
//! real, but a failed one costs no virtual time, so attempt `n` must start at
//! exactly the sum of the first `n` backoff delays. The tests step the clock
//! to 1 ms before each deadline and check that nothing has happened yet, then
//! step the last millisecond and check that the attempt runs. A park that ends
//! early or late, an extra or missing attempt, or a wrong delay fails the
//! test. No wall-clock window is involved.
//!
//! Unix-only, like the other reconnect tests: a refused loopback connect is
//! instant there, while Windows retries it for about two seconds.

use std::sync::Arc;
use std::time::Duration;

use termihub_core::reconnect_backoff::BackoffConfig;
use tokio::task::JoinHandle;

use super::alive::AgentAlive;
use super::fake_agent_sshd::{FakeAgentSshd, InitBehavior};
use super::reconnect::{reconnect_agent, ReconnectTuning, AGENT_RECONNECT_POLICY};
use super::virtual_backoff_clock::{SleepRequest, VirtualBackoffClock};
use crate::connection::config::AgentSettings;
use crate::terminal::backend::RemoteAgentConfig;

/// Real-time ceiling for any one step (a refused connect, a handshake against
/// the loopback fake). Only keeps a regression from hanging CI.
const STEP: Duration = Duration::from_secs(15);

const MS: Duration = Duration::from_millis(1);

/// The production agent reconnect policy with its jitter switched off, so the
/// schedule is exact.
pub(super) const UNJITTERED_PRODUCTION_POLICY: BackoffConfig = BackoffConfig {
    jitter_ratio: 0.0,
    ..AGENT_RECONNECT_POLICY
};

/// The backoff delays [`UNJITTERED_PRODUCTION_POLICY`] waits before each of its
/// ten attempts: 1 s doubling to the 30 s ceiling.
pub(super) const PRODUCTION_SCHEDULE_SECS: [u64; 10] = [1, 2, 4, 8, 16, 30, 30, 30, 30, 30];

/// The give-up error after the production budget.
const GIVE_UP_ERROR: &str = "Failed to reconnect after 10 attempts";

fn trust_all_host_keys() {
    use termihub_core::backends::ssh::host_key::{
        set_host_key_verifier, HostKeyInfo, HostKeyVerifier,
    };
    struct TrustAll;
    #[async_trait::async_trait]
    impl HostKeyVerifier for TrustAll {
        async fn verify(&self, _info: &HostKeyInfo) -> bool {
            true
        }
    }
    let _ = set_host_key_verifier(Arc::new(TrustAll));
}

/// The production tuning, unjittered, waiting on `clock`.
pub(super) fn virtual_tuning(clock: &'static VirtualBackoffClock) -> ReconnectTuning {
    ReconnectTuning {
        policy: UNJITTERED_PRODUCTION_POLICY,
        clock,
        ..ReconnectTuning::PRODUCTION
    }
}

/// An agent config whose endpoint is gone: a fake agent's config, after the
/// fake stopped listening. Waits until a connect is refused.
async fn dead_endpoint() -> RemoteAgentConfig {
    let fake = FakeAgentSshd::serve(InitBehavior::Answer).await;
    let config = fake.agent_config();
    drop(fake);
    let deadline = tokio::time::Instant::now() + STEP;
    while tokio::net::TcpStream::connect(("127.0.0.1", config.port))
        .await
        .is_ok()
    {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the fake agent endpoint kept listening after it was dropped"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    config
}

/// Run [`reconnect_agent`] in a task; `Ok(())` when it reconnected.
fn spawn_reconnect(
    config: RemoteAgentConfig,
    alive: Arc<AgentAlive>,
    tuning: ReconnectTuning,
) -> JoinHandle<Result<(), String>> {
    tokio::spawn(async move {
        let mut request_id = 0u64;
        reconnect_agent(
            &config,
            &AgentSettings::default(),
            &mut request_id,
            &alive,
            &tuning,
        )
        .await
        .map(|_| ())
    })
}

/// Grade one backoff round on the virtual clock (see
/// [`VirtualBackoffClock::step_round`]): parked means the loop task is still
/// running.
fn step_round(
    clock: &'static VirtualBackoffClock,
    task: &JoinHandle<Result<(), String>>,
    n: usize,
    at: Duration,
    delay: Duration,
) {
    tokio::task::block_in_place(|| clock.step_round(n, at, delay, || !task.is_finished()));
}

/// The loop's `n`th backoff request (see [`VirtualBackoffClock::nth_request`]).
fn nth_wait(clock: &'static VirtualBackoffClock, n: usize) -> SleepRequest {
    tokio::task::block_in_place(|| clock.nth_request(n))
}

/// Await the loop's outcome (bounded in real time).
async fn outcome(task: JoinHandle<Result<(), String>>) -> Result<(), String> {
    tokio::time::timeout(STEP, task)
        .await
        .expect("the reconnect loop did not settle")
        .expect("join the reconnect loop")
}

#[test]
fn the_graded_schedule_is_the_production_policy_without_jitter() {
    assert_eq!(
        BackoffConfig {
            jitter_ratio: AGENT_RECONNECT_POLICY.jitter_ratio,
            ..UNJITTERED_PRODUCTION_POLICY
        },
        AGENT_RECONNECT_POLICY
    );
    assert_eq!(
        PRODUCTION_SCHEDULE_SECS.len(),
        AGENT_RECONNECT_POLICY.max_attempts as usize
    );
}

/// A permanently dead endpoint parks the loop for the full production budget,
/// one attempt per backoff window, and gives up at exactly the sum of the ten
/// delays (181 s), not a millisecond earlier.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_dead_endpoint_parks_on_the_production_schedule_then_gives_up_on_time() {
    let clock = VirtualBackoffClock::leaked();
    let task = spawn_reconnect(dead_endpoint().await, AgentAlive::new(), virtual_tuning(clock));

    let mut at = Duration::ZERO;
    for (i, secs) in PRODUCTION_SCHEDULE_SECS.into_iter().enumerate() {
        let delay = Duration::from_secs(secs);
        step_round(clock, &task, i + 1, at, delay);
        at += delay;
    }

    assert_eq!(outcome(task).await, Err(GIVE_UP_ERROR.to_string()));
    assert_eq!(at, Duration::from_secs(181));
    assert_eq!(clock.now(), at, "the give-up must land at the end of the last window");
    assert_eq!(
        clock.requests().len(),
        PRODUCTION_SCHEDULE_SECS.len(),
        "no backoff wait after the last attempt"
    );
}

/// A user stop while the loop is parked mid-window settles it at once, with
/// the stop error, at the same virtual instant: no further attempt, no
/// waiting out the window.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_user_stop_mid_park_settles_at_once_without_another_attempt() {
    let clock = VirtualBackoffClock::leaked();
    let alive = AgentAlive::new();
    let task = spawn_reconnect(dead_endpoint().await, alive.clone(), virtual_tuning(clock));

    let mut at = Duration::ZERO;
    for (i, secs) in PRODUCTION_SCHEDULE_SECS[..3].iter().enumerate() {
        let delay = Duration::from_secs(*secs);
        step_round(clock, &task, i + 1, at, delay);
        at += delay;
    }
    // Parked in the 4th window (8 s from 7 s); stop it halfway through.
    assert_eq!(
        nth_wait(clock, 4),
        SleepRequest {
            at,
            delay: Duration::from_secs(8)
        }
    );
    clock.advance(Duration::from_secs(4));
    alive.stop();

    assert_eq!(outcome(task).await, Err("Reconnect stopped by user".to_string()));
    assert_eq!(clock.now(), Duration::from_secs(11));
    assert_eq!(clock.requests().len(), 4, "no attempt after the stop");
    assert_eq!(clock.pending(), 0, "the stop dropped the parked wait");
}

/// An endpoint that returns while the loop is parked is reached by the next
/// attempt, at exactly the end of the window it was parked in, and not before.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_returning_endpoint_reconnects_at_the_next_backoff_instant() {
    trust_all_host_keys();
    let clock = VirtualBackoffClock::leaked();
    let config = dead_endpoint().await;
    let task = spawn_reconnect(config.clone(), AgentAlive::new(), virtual_tuning(clock));

    // Attempts 1 (at 1 s) and 2 (at 3 s) hit the dead endpoint.
    step_round(clock, &task, 1, Duration::ZERO, Duration::from_secs(1));
    step_round(clock, &task, 2, Duration::from_secs(1), Duration::from_secs(2));

    // Parked in the 3rd window (4 s from 3 s): the endpoint comes back.
    assert_eq!(
        nth_wait(clock, 3),
        SleepRequest {
            at: Duration::from_secs(3),
            delay: Duration::from_secs(4)
        }
    );
    let fake = FakeAgentSshd::serve_on(config.port, InitBehavior::Answer).await;
    clock.advance(Duration::from_secs(4) - MS);
    assert!(!task.is_finished(), "reconnected before the window ran out");
    assert_eq!(fake.inits(), 0, "attempt #3 dialed before its backoff ran out");

    clock.advance(MS);
    assert_eq!(outcome(task).await, Ok(()));
    assert_eq!(fake.inits(), 1, "exactly one attempt reached the returned endpoint");
    assert_eq!(clock.now(), Duration::from_secs(7));
    assert_eq!(clock.requests().len(), 3, "no backoff wait after the success");
}
