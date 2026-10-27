//! When a connection's initial command is typed (#4345, #5029).
//!
//! The command is typed once the shell waits at its prompt, read from the
//! first signal of three, in this order of trust:
//!
//! 1. **The OSC 133 prompt-start mark** the shell prints with termiHub's
//!    shell integration on.
//! 2. **A [`PromptProbe`]** from the backend, for the default sessions that
//!    print no mark: the local shell's line editor took over the PTY, or an
//!    SSH shell's output settled at a prompt. Nothing is typed into the
//!    shell to find out.
//! 3. **A timeout**, last: [`PROBE_CAP`] when a probe is watching (it only
//!    runs out on a shell the probe cannot read, e.g. bash with line editing
//!    turned off), [`MARK_ONLY_TIMEOUT`] when nothing is.

use std::time::Duration;

use tokio::sync::Notify;

use crate::connection::PromptProbe;

/// The wait for the prompt mark when the backend has no [`PromptProbe`]:
/// serial, telnet, agent-hosted sessions, shells without a line editor.
pub const MARK_ONLY_TIMEOUT: Duration = Duration::from_secs(1);

/// Upper bound on the wait while a [`PromptProbe`] is watching. A slow rc
/// file (nvm, oh-my-zsh) delays the prompt by seconds; this only bounds a
/// probe that never reports.
pub const PROBE_CAP: Duration = Duration::from_secs(10);

/// How often the probe is asked.
pub const PROBE_POLL: Duration = Duration::from_millis(10);

/// How long the probe must keep reporting ready before it counts, so a
/// program in the rc file that switches the terminal mode for a moment (a
/// terminal query) is not taken for the prompt.
pub const PROBE_STABLE: Duration = Duration::from_millis(50);

/// What ended [`wait_for_prompt`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptSignal {
    /// The OSC 133 prompt-start mark was seen.
    Mark,
    /// The backend's probe reported the prompt.
    Probe,
    /// Neither came in time.
    Timeout,
}

/// Wait until the shell waits at its prompt: `mark` is notified on the OSC
/// 133 prompt-start mark, `probe` is the backend's hook-free check. See the
/// module docs for the order.
pub async fn wait_for_prompt(mark: Option<&Notify>, probe: Option<&PromptProbe>) -> PromptSignal {
    let timeout = if probe.is_some() {
        PROBE_CAP
    } else {
        MARK_ONLY_TIMEOUT
    };
    tokio::select! {
        () = async {
            match mark {
                Some(mark) => mark.notified().await,
                None => std::future::pending().await,
            }
        } => PromptSignal::Mark,
        () = async {
            match probe {
                Some(probe) => probe_ready(probe).await,
                None => std::future::pending().await,
            }
        } => PromptSignal::Probe,
        () = tokio::time::sleep(timeout) => PromptSignal::Timeout,
    }
}

/// Resolve once `probe` has reported ready for [`PROBE_STABLE`] in a row.
async fn probe_ready(probe: &PromptProbe) {
    let mut ready_since: Option<tokio::time::Instant> = None;
    loop {
        let now = tokio::time::Instant::now();
        if probe() {
            let since = *ready_since.get_or_insert(now);
            if now.duration_since(since) >= PROBE_STABLE {
                return;
            }
        } else {
            ready_since = None;
        }
        tokio::time::sleep(PROBE_POLL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    fn flag_probe() -> (Arc<AtomicBool>, PromptProbe) {
        let flag = Arc::new(AtomicBool::new(false));
        let probe_flag = flag.clone();
        (flag, Arc::new(move || probe_flag.load(Ordering::SeqCst)))
    }

    #[tokio::test(start_paused = true)]
    async fn without_mark_or_probe_it_times_out_after_the_short_wait() {
        let start = tokio::time::Instant::now();
        assert_eq!(wait_for_prompt(None, None).await, PromptSignal::Timeout);
        assert_eq!(start.elapsed(), MARK_ONLY_TIMEOUT);
    }

    #[tokio::test(start_paused = true)]
    async fn the_mark_wins_at_once() {
        let mark = Notify::new();
        mark.notify_one();
        let (_flag, probe) = flag_probe();
        assert_eq!(
            wait_for_prompt(Some(&mark), Some(&probe)).await,
            PromptSignal::Mark
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_probe_waits_past_the_short_timeout_for_the_prompt() {
        let (flag, probe) = flag_probe();
        let start = tokio::time::Instant::now();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(3)).await;
            flag.store(true, Ordering::SeqCst);
        });
        assert_eq!(
            wait_for_prompt(None, Some(&probe)).await,
            PromptSignal::Probe
        );
        let waited = start.elapsed();
        assert!(
            waited >= Duration::from_secs(3) + PROBE_STABLE,
            "{waited:?}"
        );
        assert!(waited < Duration::from_secs(3) + Duration::from_millis(200));
    }

    #[tokio::test(start_paused = true)]
    async fn a_probe_that_never_reports_is_capped() {
        let (_flag, probe) = flag_probe();
        let start = tokio::time::Instant::now();
        assert_eq!(
            wait_for_prompt(None, Some(&probe)).await,
            PromptSignal::Timeout
        );
        assert_eq!(start.elapsed(), PROBE_CAP);
    }

    #[tokio::test(start_paused = true)]
    async fn a_moment_of_ready_does_not_count() {
        let (flag, probe) = flag_probe();
        let blip = flag.clone();
        tokio::spawn(async move {
            // A terminal query in the rc file: ready for 20 ms only.
            tokio::time::sleep(Duration::from_secs(1)).await;
            blip.store(true, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(20)).await;
            blip.store(false, Ordering::SeqCst);
            // The real prompt.
            tokio::time::sleep(Duration::from_secs(2)).await;
            blip.store(true, Ordering::SeqCst);
        });
        let start = tokio::time::Instant::now();
        assert_eq!(
            wait_for_prompt(None, Some(&probe)).await,
            PromptSignal::Probe
        );
        assert!(
            start.elapsed() >= Duration::from_secs(3),
            "{:?}",
            start.elapsed()
        );
        drop(flag);
    }
}
