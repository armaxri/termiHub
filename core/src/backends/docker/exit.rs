//! The exit status of a Docker session that ended on its own (#5783).
//!
//! The interactive shell runs as a `docker exec` inside the container. Its
//! output stream ends when the shell exits (the user typed `exit`) or when the
//! container stops underneath it (`docker stop`, the main process died). The
//! reader task then asks the engine how it ended — the exec's exit code, or
//! the stopped container's — records it, and only then closes the session's
//! output channel, so the status is known by the time the session owner sees
//! the output end and reads
//! [`exit_code`](crate::connection::ConnectionType::exit_code). Before this the
//! reader left the channel open, so a stopped container kept its tab open.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use tracing::debug;

use crate::connection::OutputSender;

/// How often the reader re-asks while the engine still reports the exec as
/// running (it can lag the end of the output stream by a moment).
const INSPECT_ATTEMPTS: usize = 10;
/// The pause between two inspections.
const INSPECT_INTERVAL: Duration = Duration::from_millis(100);

/// What the engine says about a process: the exec or the container's main one.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct ProcState {
    /// Whether it still runs, when the engine says.
    pub(super) running: Option<bool>,
    /// Its exit code, once it has one.
    pub(super) exit_code: Option<i64>,
}

impl ProcState {
    /// The exit code of a process the engine reports as finished.
    fn finished_code(self) -> Option<i64> {
        match self.running {
            Some(true) => None,
            _ => self.exit_code,
        }
    }
}

/// Reads the state of a session's exec and container (a seam so the decision
/// is tested without a Docker engine).
#[async_trait::async_trait]
pub(super) trait ExitInspector: Send + Sync {
    /// The interactive exec's state; `None` when it cannot be inspected.
    async fn exec_state(&self) -> Option<ProcState>;
    /// The container's state; `None` when it cannot be inspected (removed).
    async fn container_state(&self) -> Option<ProcState>;
}

/// [`ExitInspector`] backed by the Docker engine API.
pub(super) struct EngineInspector {
    pub(super) client: bollard::Docker,
    pub(super) exec_id: String,
    pub(super) container_id: String,
}

#[async_trait::async_trait]
impl ExitInspector for EngineInspector {
    async fn exec_state(&self) -> Option<ProcState> {
        let inspect = self.client.inspect_exec(&self.exec_id).await.ok()?;
        Some(ProcState {
            running: inspect.running,
            exit_code: inspect.exit_code,
        })
    }

    async fn container_state(&self) -> Option<ProcState> {
        let inspect = self
            .client
            .inspect_container(&self.container_id, None)
            .await
            .ok()?;
        let state = inspect.state?;
        Some(ProcState {
            running: state.running,
            exit_code: state.exit_code,
        })
    }
}

/// The session's exit status, from one look at its exec and its container:
/// the exec's code once it finished (the shell the user exited), else the
/// code of a container that stopped under it. `Err(())` while both still run
/// — the engine has not caught up with the stream's end yet.
fn decide(exec: Option<ProcState>, container: Option<ProcState>) -> Result<Option<i32>, ()> {
    let to_i32 = |code: i64| i32::try_from(code).ok();
    if let Some(code) = exec.and_then(ProcState::finished_code) {
        return Ok(to_i32(code));
    }
    if let Some(code) = container.and_then(ProcState::finished_code) {
        return Ok(to_i32(code));
    }
    let still_running = |s: Option<ProcState>| s.is_some_and(|s| s.running == Some(true));
    if still_running(exec) || still_running(container) {
        Err(())
    } else {
        // Neither can be read (the container is gone): no status.
        Ok(None)
    }
}

/// Ask `inspector` how the session ended, re-asking briefly while the engine
/// still reports it running. `None` when no status can be read.
pub(super) async fn read_exit_status(
    inspector: &dyn ExitInspector,
    attempts: usize,
    interval: Duration,
) -> Option<i32> {
    for attempt in 0..attempts.max(1) {
        if attempt > 0 {
            tokio::time::sleep(interval).await;
        }
        let exec = inspector.exec_state().await;
        let container = inspector.container_state().await;
        if let Ok(status) = decide(exec, container) {
            return status;
        }
    }
    debug!("Docker session still reported running after its output ended");
    None
}

/// The exit status a Docker session recorded when it ended on its own.
pub(super) type ExitStatusSlot = Arc<Mutex<Option<i32>>>;

/// Read the recorded status.
pub(super) fn recorded(slot: &ExitStatusSlot) -> Option<i32> {
    *slot.lock().unwrap_or_else(PoisonError::into_inner)
}

/// End the session after its exec's output stream ended.
///
/// When the session ended on its own (`alive` still set — a deliberate
/// disconnect clears it first), its exit status is recorded and the stored
/// output sender dropped, so the session owner sees the output end and reads
/// the status. A deliberate disconnect records nothing: it already cleared the
/// sender itself.
pub(super) async fn finish_session(
    inspector: &dyn ExitInspector,
    alive: &AtomicBool,
    slot: &ExitStatusSlot,
    output_tx: &Mutex<Option<OutputSender>>,
) {
    finish_session_with(
        inspector,
        alive,
        slot,
        output_tx,
        INSPECT_ATTEMPTS,
        INSPECT_INTERVAL,
    )
    .await;
}

async fn finish_session_with(
    inspector: &dyn ExitInspector,
    alive: &AtomicBool,
    slot: &ExitStatusSlot,
    output_tx: &Mutex<Option<OutputSender>>,
    attempts: usize,
    interval: Duration,
) {
    if !alive.load(Ordering::SeqCst) {
        return;
    }
    let status = read_exit_status(inspector, attempts, interval).await;
    debug!(?status, "Docker session ended on its own");
    *slot.lock().unwrap_or_else(PoisonError::into_inner) = status;
    alive.store(false, Ordering::SeqCst);
    *output_tx.lock().unwrap_or_else(PoisonError::into_inner) = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::collections::VecDeque;

    const RUNNING: ProcState = ProcState {
        running: Some(true),
        exit_code: None,
    };

    fn exited(code: i64) -> ProcState {
        ProcState {
            running: Some(false),
            exit_code: Some(code),
        }
    }

    /// Scripted engine: each inspection pops the next (exec, container) pair,
    /// repeating the last one.
    struct FakeEngine {
        looks: Mutex<VecDeque<(Option<ProcState>, Option<ProcState>)>>,
        current: Mutex<(Option<ProcState>, Option<ProcState>)>,
    }

    impl FakeEngine {
        fn new(looks: Vec<(Option<ProcState>, Option<ProcState>)>) -> Self {
            Self {
                looks: Mutex::new(looks.into()),
                current: Mutex::new((None, None)),
            }
        }
    }

    #[async_trait::async_trait]
    impl ExitInspector for FakeEngine {
        async fn exec_state(&self) -> Option<ProcState> {
            let next = self.looks.lock().unwrap().pop_front();
            let mut current = self.current.lock().unwrap();
            if let Some(next) = next {
                *current = next;
            }
            current.0
        }

        async fn container_state(&self) -> Option<ProcState> {
            self.current.lock().unwrap().1
        }
    }

    async fn status_of(looks: Vec<(Option<ProcState>, Option<ProcState>)>) -> Option<i32> {
        read_exit_status(&FakeEngine::new(looks), 5, Duration::ZERO).await
    }

    #[tokio::test]
    async fn a_shell_the_user_exited_reports_the_exec_code() {
        assert_eq!(
            status_of(vec![(Some(exited(3)), Some(RUNNING))]).await,
            Some(3)
        );
        assert_eq!(
            status_of(vec![(Some(exited(0)), Some(RUNNING))]).await,
            Some(0)
        );
    }

    #[tokio::test]
    async fn a_stopped_container_reports_its_own_code() {
        // `docker stop` kills the exec without an exit code of its own.
        let killed_exec = ProcState {
            running: Some(false),
            exit_code: None,
        };
        assert_eq!(
            status_of(vec![(Some(killed_exec), Some(exited(137)))]).await,
            Some(137)
        );
        // The engine may keep the killed exec "running"; the container decides.
        assert_eq!(
            status_of(vec![(Some(RUNNING), Some(exited(143)))]).await,
            Some(143)
        );
    }

    #[tokio::test]
    async fn a_lagging_engine_is_asked_again() {
        let looks = vec![
            (Some(RUNNING), Some(RUNNING)),
            (Some(RUNNING), Some(RUNNING)),
            (Some(exited(7)), Some(RUNNING)),
        ];
        assert_eq!(status_of(looks).await, Some(7));
    }

    #[tokio::test]
    async fn an_exec_that_never_settles_reports_no_status() {
        assert_eq!(status_of(vec![(Some(RUNNING), Some(RUNNING))]).await, None);
    }

    #[tokio::test]
    async fn a_removed_container_reports_no_status() {
        assert_eq!(status_of(vec![(None, None)]).await, None);
    }

    #[test]
    fn an_out_of_range_code_is_no_status() {
        assert_eq!(decide(Some(exited(i64::MAX)), None), Ok(None));
    }

    #[tokio::test]
    async fn finishing_on_its_own_records_the_status_and_closes_the_output() {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(1);
        let output_tx = Mutex::new(Some(tx));
        let alive = AtomicBool::new(true);
        let slot = ExitStatusSlot::default();
        let engine = FakeEngine::new(vec![(Some(exited(2)), Some(RUNNING))]);

        finish_session_with(&engine, &alive, &slot, &output_tx, 1, Duration::ZERO).await;

        assert_eq!(recorded(&slot), Some(2));
        assert!(!alive.load(Ordering::SeqCst));
        assert_eq!(rx.recv().await, None, "the output channel closes");
    }

    #[tokio::test]
    async fn a_deliberate_disconnect_records_nothing() {
        let output_tx = Mutex::new(None);
        let alive = AtomicBool::new(false);
        let slot = ExitStatusSlot::default();
        let engine = FakeEngine::new(vec![(Some(exited(2)), None)]);

        finish_session_with(&engine, &alive, &slot, &output_tx, 1, Duration::ZERO).await;

        assert_eq!(recorded(&slot), None);
    }
}
