//! An initial command held because the shell never announced its prompt
//! (#5509).
//!
//! For a local bash / zsh from 5.1 the initial command waits for the line
//! editor's bracketed-paste mark without a cap (#5455): typing on a timeout
//! could only answer a startup question. A user who turned bracketed paste off
//! never gets that mark, so the command would wait silently forever. After
//! [`HELD_NOTICE_AFTER`] (the former cap) the session manager emits an
//! [`InitialCommandHeldEvent`] so the tab can show a notice with a **Send now**
//! action; [`SessionManager::send_held_initial_command`] is that action. The
//! command is still never typed on its own, and it is typed exactly once —
//! by whichever comes first, the prompt or the user's confirmation.
//!
//! The typed shell-integration setup of such a shell waits for the same mark
//! ([`GatedSetup`], #5512), and with it the initial command, which waits for
//! the prompt mark the setup brings rather than for a timeout. The same notice
//! then covers the setup: **Send now** types the setup, and then the initial
//! command once the setup's prompt mark is seen.
//!
//! A setup on the canonical-mode cue (macOS `/bin/bash` 3.2, zsh before 5.1)
//! waits for the PTY to leave canonical mode; past its cap ([`GatedSetup::cap`])
//! it counts as held (#5525, #5564). The initial command waits for the setup's
//! prompt mark, never for the 1 s mark-only timeout, which would type it into a
//! still-cooked tty ahead of the setup. Past the cap plus [`SETUP_CAP_MARGIN`]
//! the tab gets the same notice: **Send now** types the setup, then the command;
//! neither is ever typed blind. A late cue still types the setup as usual.

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use serde::Serialize;
use tokio::sync::Notify;
use tracing::info;

use termihub_core::connection::{GatedSetup, PromptProbe};
use termihub_core::session::prompt_ready::{
    wait_for_prompt_uncapped, PromptSignal, PROBE_CAP, PROBE_POLL,
};

use super::{EventEmitter, SessionManager};

/// How long an uncapped initial command waits before the tab is told it is
/// held: the cap the wait had before #5455.
pub const HELD_NOTICE_AFTER: Duration = PROBE_CAP;

/// How long past a capped setup's [`GatedSetup::cap`] the tab waits before it
/// is told the setup (and the initial command) is held (#5525, #5564): a setup
/// typed just before the cap runs and prints its prompt in that time.
pub const SETUP_CAP_MARGIN: Duration = Duration::from_secs(2);

/// Payload of the `initial-command-held` event.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct InitialCommandHeldEvent {
    /// The session whose initial command is waiting.
    pub session_id: String,
    /// `true` once the command is held past `HELD_NOTICE_AFTER`; `false`
    /// when it went out (at the prompt or on **Send now**) or the session
    /// closed.
    pub held: bool,
    /// The shell-integration setup (command marks) is held too (#5512).
    pub setup: bool,
    /// An initial command is held; `false` when only the setup is.
    pub initial_command: bool,
}

/// What sent the initial command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum InitialCommandCue {
    /// The shell reached its prompt (or the capped wait ran out).
    Prompt(PromptSignal),
    /// The user confirmed **Send now** on the held notice.
    SendNow,
}

/// The initial commands currently held, each with the signal that sends it.
#[derive(Clone)]
pub(crate) struct HeldInitialCommands {
    release: Arc<StdMutex<HashMap<String, Arc<Notify>>>>,
    notice_after: Duration,
    /// [`SETUP_CAP_MARGIN`], shorter in tests.
    cap_margin: Duration,
}

impl Default for HeldInitialCommands {
    fn default() -> Self {
        Self {
            release: Arc::default(),
            notice_after: HELD_NOTICE_AFTER,
            cap_margin: SETUP_CAP_MARGIN,
        }
    }
}

impl HeldInitialCommands {
    /// How long to wait before the tab is told the command is held.
    #[cfg(test)]
    fn notice_after(&self) -> Duration {
        self.notice_after
    }

    /// Mark `session_id`'s command held; `release` is notified on **Send now**.
    fn hold(&self, session_id: &str, release: Arc<Notify>) {
        if let Ok(mut map) = self.release.lock() {
            map.insert(session_id.to_string(), release);
        }
    }

    /// Forget `session_id`'s held command; whether it was held.
    fn forget(&self, session_id: &str) -> bool {
        self.release
            .lock()
            .is_ok_and(|mut map| map.remove(session_id).is_some())
    }

    /// Wait for the prompt without a cap, telling the tab after
    /// the notice delay that the command is held. Ends on
    /// the prompt or on **Send now**, whichever comes first, so the caller
    /// types the command exactly once.
    pub(super) async fn wait_or_send_now<E: EventEmitter>(
        &self,
        session_id: &str,
        emitter: &E,
        ready: &Notify,
        probe: Option<&PromptProbe>,
    ) -> InitialCommandCue {
        let release = Arc::new(Notify::new());
        tokio::select! {
            signal = wait_for_prompt_uncapped(Some(ready), probe) => InitialCommandCue::Prompt(signal),
            () = async {
                tokio::time::sleep(self.notice_after).await;
                info!(session_id, "Initial command held: no prompt from the shell yet");
                self.hold(session_id, release.clone());
                emitter.emit_initial_command_held(&InitialCommandHeldEvent {
                    session_id: session_id.to_string(),
                    held: true,
                    setup: false,
                    initial_command: true,
                });
                release.notified().await;
            } => InitialCommandCue::SendNow,
        }
    }

    /// Wait while `setup` is held for the line editor's mark (#5512), with
    /// no cap, telling the tab after the notice delay; for a capped setup
    /// (#5525), after its cap plus [`SETUP_CAP_MARGIN`]. With an initial
    /// command (`ready`, the OSC 133 prompt-start mark) the wait ends on the
    /// prompt the setup brings; without one, once the setup was typed. Ends
    /// on **Send now** too, whichever comes first; the caller then types the
    /// setup ([`send_now_with_setup`](Self::send_now_with_setup)).
    pub(super) async fn wait_for_setup_or_send_now<E: EventEmitter>(
        &self,
        session_id: &str,
        emitter: &E,
        ready: Option<&Notify>,
        setup: &Arc<dyn GatedSetup>,
    ) -> InitialCommandCue {
        let release = Arc::new(Notify::new());
        tokio::select! {
            () = async {
                match ready {
                    Some(ready) => ready.notified().await,
                    None => {
                        while setup.is_pending() {
                            tokio::time::sleep(PROBE_POLL).await;
                        }
                    }
                }
            } => InitialCommandCue::Prompt(PromptSignal::Mark),
            () = async {
                tokio::time::sleep(self.setup_notice_after(setup)).await;
                let pending = setup.is_pending();
                info!(session_id, setup = pending, "Held: no prompt from the shell yet");
                self.hold(session_id, release.clone());
                emitter.emit_initial_command_held(&InitialCommandHeldEvent {
                    session_id: session_id.to_string(),
                    held: true,
                    setup: pending,
                    initial_command: ready.is_some(),
                });
                release.notified().await;
            } => InitialCommandCue::SendNow,
        }
    }

    /// When the tab is told that `setup` (and the initial command behind
    /// it) is held: after the notice delay, or past a capped setup's cap.
    fn setup_notice_after(&self, setup: &Arc<dyn GatedSetup>) -> Duration {
        match setup.cap() {
            Some(cap) => cap + self.cap_margin,
            None => self.notice_after,
        }
    }

    /// **Send now** for a held setup: type it, then (with an initial
    /// command, `ready`) wait for the prompt mark it brings, so the command
    /// never lands in the middle of it. The user asked for both, so the
    /// command follows after [`PROBE_CAP`] even if the mark never comes.
    pub(super) async fn send_now_with_setup(setup: &Arc<dyn GatedSetup>, ready: Option<&Notify>) {
        if !setup.is_pending() {
            return;
        }
        setup.send_now();
        if let Some(ready) = ready {
            let _ = tokio::time::timeout(PROBE_CAP, ready.notified()).await;
        }
    }

    /// The wait ended (`cue`; `None` when the session closed first): clear a
    /// held notice in the tab.
    pub(super) fn settle<E: EventEmitter>(
        &self,
        session_id: &str,
        emitter: &E,
        cue: Option<InitialCommandCue>,
    ) {
        // Send now already took the entry out of the map.
        let was_held = self.forget(session_id) || cue == Some(InitialCommandCue::SendNow);
        if was_held {
            emitter.emit_initial_command_held(&InitialCommandHeldEvent {
                session_id: session_id.to_string(),
                held: false,
                setup: false,
                initial_command: false,
            });
        }
    }

    /// Release `session_id`'s held command; whether one was held. Taking it
    /// out of the map makes a second **Send now** a no-op.
    fn release(&self, session_id: &str) -> bool {
        let notify = self
            .release
            .lock()
            .ok()
            .and_then(|mut map| map.remove(session_id));
        match notify {
            Some(notify) => {
                // `notify_one` stores a permit, so a release that races the
                // waiter still counts.
                notify.notify_one();
                true
            }
            None => false,
        }
    }
}

impl SessionManager {
    /// **Send now** for a held initial command (#5509) or setup (#5512):
    /// type it at once (the setup first, then the command). Returns whether
    /// anything was held; `false` (already sent, never held, or the session
    /// is gone) sends nothing.
    pub fn send_held_initial_command(&self, session_id: &str) -> bool {
        let released = self.held_initial_commands.release(session_id);
        info!(session_id, released, "Send now for a held initial command");
        released
    }

    /// Shorten the notice delay, for tests.
    #[cfg(test)]
    pub(super) fn set_held_notice_after(&mut self, after: Duration) {
        self.held_initial_commands.notice_after = after;
    }

    /// Shorten the margin past a capped setup's cap, for tests.
    #[cfg(test)]
    pub(super) fn set_setup_cap_margin(&mut self, margin: Duration) {
        self.held_initial_commands.cap_margin = margin;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn release_notifies_once_and_only_when_held() {
        let held = HeldInitialCommands::default();
        assert!(!held.release("s"), "nothing held yet");
        let notify = Arc::new(Notify::new());
        held.hold("s", notify.clone());
        assert!(held.release("s"));
        assert!(!held.release("s"), "a second Send now is a no-op");
        // The permit stored by the first release wakes the waiter.
        tokio::time::timeout(Duration::from_secs(1), notify.notified())
            .await
            .expect("released");
    }

    #[test]
    fn forget_reports_whether_it_was_held() {
        let held = HeldInitialCommands::default();
        assert!(!held.forget("s"));
        held.hold("s", Arc::new(Notify::new()));
        assert!(held.forget("s"));
        assert!(!held.release("s"));
    }

    #[test]
    fn the_notice_comes_after_the_former_cap() {
        assert_eq!(HeldInitialCommands::default().notice_after(), PROBE_CAP);
    }

    struct Capped(Option<Duration>);
    impl GatedSetup for Capped {
        fn is_pending(&self) -> bool {
            true
        }
        fn send_now(&self) {}
        fn cap(&self) -> Option<Duration> {
            self.0
        }
    }

    #[test]
    fn a_capped_setup_is_waited_for_past_its_cap() {
        let held = HeldInitialCommands::default();
        let capped: Arc<dyn GatedSetup> = Arc::new(Capped(Some(Duration::from_secs(10))));
        assert_eq!(
            held.setup_notice_after(&capped),
            Duration::from_secs(10) + SETUP_CAP_MARGIN
        );
        let uncapped: Arc<dyn GatedSetup> = Arc::new(Capped(None));
        assert_eq!(held.setup_notice_after(&uncapped), HELD_NOTICE_AFTER);
    }
}
