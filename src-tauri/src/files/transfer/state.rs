//! Pure transfer state machine (issue #1336).
//!
//! This module holds *only* the state/transition logic for a queued transfer —
//! no I/O, no async, no Tauri. That keeps every transition (valid and invalid)
//! unit-testable without a live FTP/SFTP server, which is the high-value,
//! macOS-runnable coverage called for by the concept
//! (`docs/concepts/partial/ftp-client.html`, "Transfer Queue State Machine").
//!
//! ```text
//! [*] --> Queued
//! Queued  --> Active     : slot available (Activate)
//! Active  --> Paused     : user pause
//! Active  --> Completed  : transfer done
//! Active  --> Failed     : error (retryable or not)
//! Active  --> Cancelled  : user cancel
//! Paused  --> Queued     : user resume (re-enters the queue for a free slot)
//! Paused  --> Cancelled  : user cancel
//! Failed  --> Queued     : retry (auto/manual)
//! Failed  --> Cancelled  : user cancel
//! ```
//!
//! `Resume` deliberately returns to `Queued` rather than straight to `Active`:
//! a paused transfer releases its concurrency slot, so on resume it must
//! re-acquire one through the scheduler (which may promote a different queued
//! transfer first).
//!
//! `Completed` and `Cancelled` are terminal.

use serde::Serialize;

/// Maximum number of automatic retry attempts before a transfer is surfaced as
/// permanently failed (concept: "retry up to 3 times automatically").
pub const MAX_RETRIES: u32 = 3;

/// Lifecycle state of a single queued transfer.
///
/// `Failed` carries the number of attempts made so far and whether another
/// retry is still permitted, so the UI can render `failed (n/3)` and the
/// executor can decide whether to auto-retry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransferState {
    /// Waiting for a concurrency slot on its session.
    Queued,
    /// Holding a slot and actively moving bytes.
    Active,
    /// User-paused; keeps its resume offset, releases its slot.
    Paused,
    /// Ran to completion (terminal).
    Completed,
    /// Errored. `attempt` is how many attempts have been made (1-based);
    /// `retryable` is whether attempts remain (`attempt < MAX_RETRIES`).
    Failed { attempt: u32, retryable: bool },
    /// User-cancelled (terminal).
    Cancelled,
}

/// Wire-friendly, flattened tag for a [`TransferState`], serialised as a plain
/// lowercase string in the `transfer-progress` payload's `state` field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferStateTag {
    Queued,
    Active,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

impl TransferStateTag {
    /// Whether this tag is a settled outcome the reconcile treats as final
    /// (`completed`/`failed`/`cancelled`). Unlike [`TransferState::is_terminal`]
    /// — which is about the state machine's own no-further-transitions states —
    /// this mirrors the frontend's `TERMINAL_TRANSFER_STATES`, where a
    /// permanently `failed` transfer is also a settled row (#1645).
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            TransferStateTag::Completed | TransferStateTag::Failed | TransferStateTag::Cancelled
        )
    }
}

/// An event that may drive a [`TransferState`] transition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransferEvent {
    /// A concurrency slot became available; start moving bytes.
    Activate,
    /// User requested a pause.
    Pause,
    /// User requested a resume of a paused transfer.
    Resume,
    /// The byte copy reached EOF successfully.
    Complete,
    /// The copy errored. `attempt` is the 1-based attempt number that failed.
    Fail { attempt: u32 },
    /// Re-queue a failed transfer (auto after backoff, or manual).
    Retry,
    /// User requested cancellation.
    Cancel,
}

/// Raised when an event is not legal for the current state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidTransition {
    pub from: TransferState,
    pub event: TransferEvent,
}

impl std::fmt::Display for InvalidTransition {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "invalid transfer transition: {:?} cannot handle {:?}",
            self.from, self.event
        )
    }
}

impl std::error::Error for InvalidTransition {}

impl TransferState {
    /// The flattened wire tag for this state.
    pub fn tag(self) -> TransferStateTag {
        match self {
            TransferState::Queued => TransferStateTag::Queued,
            TransferState::Active => TransferStateTag::Active,
            TransferState::Paused => TransferStateTag::Paused,
            TransferState::Completed => TransferStateTag::Completed,
            TransferState::Failed { .. } => TransferStateTag::Failed,
            TransferState::Cancelled => TransferStateTag::Cancelled,
        }
    }

    /// Whether this is a terminal state (no further transitions, row cleared).
    pub fn is_terminal(self) -> bool {
        matches!(self, TransferState::Completed | TransferState::Cancelled)
    }

    /// Whether the transfer is currently occupying a concurrency slot.
    pub fn is_active(self) -> bool {
        matches!(self, TransferState::Active)
    }

    /// Apply `event`, returning the next state or an [`InvalidTransition`].
    ///
    /// This is the single authority for what transitions are legal; the async
    /// executor and the command handlers both route every change through here.
    pub fn apply(self, event: TransferEvent) -> Result<TransferState, InvalidTransition> {
        use TransferEvent as E;
        use TransferState as S;

        let next = match (self, event) {
            (S::Queued, E::Activate) => S::Active,
            (S::Active, E::Pause) => S::Paused,
            (S::Paused, E::Resume) => S::Queued,
            (S::Active, E::Complete) => S::Completed,
            (S::Active, E::Fail { attempt }) => S::Failed {
                attempt,
                retryable: attempt < MAX_RETRIES,
            },
            (
                S::Failed {
                    retryable: true, ..
                },
                E::Retry,
            ) => S::Queued,
            // Cancellation is legal from any non-terminal state.
            (S::Queued | S::Active | S::Paused | S::Failed { .. }, E::Cancel) => S::Cancelled,
            (from, event) => return Err(InvalidTransition { from, event }),
        };
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn happy_path_queued_to_completed() {
        let s = TransferState::Queued;
        let s = s.apply(TransferEvent::Activate).unwrap();
        assert_eq!(s, TransferState::Active);
        let s = s.apply(TransferEvent::Complete).unwrap();
        assert_eq!(s, TransferState::Completed);
        assert!(s.is_terminal());
    }

    #[test]
    fn pause_resume_round_trip() {
        let s = TransferState::Active;
        let s = s.apply(TransferEvent::Pause).unwrap();
        assert_eq!(s, TransferState::Paused);
        assert!(!s.is_active());
        // Resume re-enters the queue; a free slot then re-activates it.
        let s = s.apply(TransferEvent::Resume).unwrap();
        assert_eq!(s, TransferState::Queued);
        let s = s.apply(TransferEvent::Activate).unwrap();
        assert_eq!(s, TransferState::Active);
    }

    #[test]
    fn fail_is_retryable_below_the_cap() {
        let s = TransferState::Active;
        let s = s.apply(TransferEvent::Fail { attempt: 1 }).unwrap();
        assert_eq!(
            s,
            TransferState::Failed {
                attempt: 1,
                retryable: true
            }
        );
        // A retryable failure can be re-queued.
        let s = s.apply(TransferEvent::Retry).unwrap();
        assert_eq!(s, TransferState::Queued);
    }

    #[test]
    fn fail_at_the_cap_is_not_retryable() {
        let s = TransferState::Active;
        let s = s
            .apply(TransferEvent::Fail {
                attempt: MAX_RETRIES,
            })
            .unwrap();
        assert_eq!(
            s,
            TransferState::Failed {
                attempt: MAX_RETRIES,
                retryable: false
            }
        );
        // A non-retryable failure rejects Retry.
        let err = s.apply(TransferEvent::Retry).unwrap_err();
        assert_eq!(err.event, TransferEvent::Retry);
    }

    #[test]
    fn cancel_is_legal_from_every_nonterminal_state() {
        for from in [
            TransferState::Queued,
            TransferState::Active,
            TransferState::Paused,
            TransferState::Failed {
                attempt: 2,
                retryable: true,
            },
        ] {
            assert_eq!(
                from.apply(TransferEvent::Cancel).unwrap(),
                TransferState::Cancelled,
                "cancel from {from:?} must reach Cancelled"
            );
        }
    }

    #[test]
    fn terminal_states_reject_all_events() {
        for terminal in [TransferState::Completed, TransferState::Cancelled] {
            for event in [
                TransferEvent::Activate,
                TransferEvent::Pause,
                TransferEvent::Resume,
                TransferEvent::Complete,
                TransferEvent::Fail { attempt: 1 },
                TransferEvent::Retry,
                TransferEvent::Cancel,
            ] {
                assert!(
                    terminal.apply(event).is_err(),
                    "terminal {terminal:?} must reject {event:?}"
                );
            }
        }
    }

    #[test]
    fn invalid_transitions_are_rejected() {
        // Cannot pause something that is not active.
        assert!(TransferState::Queued.apply(TransferEvent::Pause).is_err());
        // Cannot resume something that is not paused.
        assert!(TransferState::Active.apply(TransferEvent::Resume).is_err());
        // Cannot complete a queued (not yet started) transfer.
        assert!(TransferState::Queued
            .apply(TransferEvent::Complete)
            .is_err());
        // Cannot activate an already-active transfer.
        assert!(TransferState::Active
            .apply(TransferEvent::Activate)
            .is_err());
    }

    #[test]
    fn tag_maps_every_state() {
        assert_eq!(TransferState::Queued.tag(), TransferStateTag::Queued);
        assert_eq!(TransferState::Active.tag(), TransferStateTag::Active);
        assert_eq!(TransferState::Paused.tag(), TransferStateTag::Paused);
        assert_eq!(TransferState::Completed.tag(), TransferStateTag::Completed);
        assert_eq!(TransferState::Cancelled.tag(), TransferStateTag::Cancelled);
        assert_eq!(
            TransferState::Failed {
                attempt: 3,
                retryable: false
            }
            .tag(),
            TransferStateTag::Failed
        );
    }

    #[test]
    fn state_tag_serialises_lowercase() {
        let json = serde_json::to_string(&TransferStateTag::Queued).unwrap();
        assert_eq!(json, "\"queued\"");
        let json = serde_json::to_string(&TransferStateTag::Failed).unwrap();
        assert_eq!(json, "\"failed\"");
    }
}
