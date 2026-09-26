//! Authoritative per-session bookkeeping of held graphical input (#3402).
//!
//! A key or mouse button that is down on the remote when the controlling window
//! loses the session (a takeover, #3388), when the transport is re-dialled
//! (#3364), or when the local canvas / window loses focus would otherwise stay
//! pressed on the remote forever: the evicted window's input is gated off in the
//! command layer, a re-dialled connection knows nothing of the old one, and a
//! blurred canvas never sees the key-up.
//!
//! The backend is the only party that sees every forwarded event, so it keeps
//! the authoritative set of pressed keys (`KeyboardEvent.code`) and the pressed
//! pointer-button bitmask here, and can synthesise the exact key-up /
//! button-up events to release them — without the (possibly evicted) frontend.
//!
//! The held set is tagged with the window that produced it, so a release on
//! takeover drops only the *previous* controller's input and never the new
//! owner's.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex as StdMutex, MutexGuard};

use tracing::debug;

use termihub_core::connection::{GraphicalBackend, InputEvent};

/// The keys and pointer buttons currently held on a session's remote.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct HeldInput {
    /// Pressed keys by `KeyboardEvent.code`, ordered so releases are deterministic.
    keys: BTreeSet<String>,
    /// Pressed-button bitmask (DOM `MouseEvent.buttons` convention).
    buttons: u8,
    /// Last pointer position, where a synthetic button-up is delivered.
    pointer: (u32, u32),
    /// The window whose input produced the held state, when known.
    source: Option<String>,
}

impl HeldInput {
    /// Record an event that was forwarded to the remote from `source`.
    pub(crate) fn observe(&mut self, source: Option<&str>, event: &InputEvent) {
        match event {
            InputEvent::Key { code, pressed } => {
                if *pressed {
                    self.keys.insert(code.clone());
                } else {
                    self.keys.remove(code);
                }
            }
            InputEvent::Pointer { x, y, buttons } => {
                self.pointer = (*x, *y);
                self.buttons = *buttons;
            }
            InputEvent::Wheel { x, y, .. } => self.pointer = (*x, *y),
        }
        if let Some(source) = source {
            self.source = Some(source.to_string());
        }
    }

    /// Whether nothing is held.
    pub(crate) fn is_empty(&self) -> bool {
        self.keys.is_empty() && self.buttons == 0
    }

    /// Whether the held input was produced by a window other than `window`.
    ///
    /// Untagged held input (from an internal caller) counts as foreign.
    pub(crate) fn held_by_other_than(&self, window: &str) -> bool {
        !self.is_empty() && self.source.as_deref() != Some(window)
    }

    /// The events that release everything held — one key-up per held key (in
    /// code order), then a single all-buttons-up pointer event at the last
    /// pointer position — and reset to the empty, untagged state. Idempotent:
    /// a second call returns nothing.
    pub(crate) fn take_release_events(&mut self) -> Vec<InputEvent> {
        let mut events: Vec<InputEvent> = std::mem::take(&mut self.keys)
            .into_iter()
            .map(|code| InputEvent::Key {
                code,
                pressed: false,
            })
            .collect();
        if self.buttons != 0 {
            let (x, y) = self.pointer;
            events.push(InputEvent::Pointer { x, y, buttons: 0 });
            self.buttons = 0;
        }
        self.source = None;
        events
    }
}

/// A session's held input, shared by the manager and its supervisor.
pub(crate) type SharedHeldInput = Arc<StdMutex<HeldInput>>;

/// Lock the held-input state, recovering it from a poisoned lock (the state is
/// plain bookkeeping, always consistent between statements).
pub(crate) fn lock_held(held: &SharedHeldInput) -> MutexGuard<'_, HeldInput> {
    held.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Deliver synthetic release events to `backend`. A failed send is logged, not
/// retried — the remote it would reach is gone or going. Returns how many were
/// delivered.
pub(crate) async fn deliver_releases(
    backend: &dyn GraphicalBackend,
    session_id: &str,
    events: Vec<InputEvent>,
) -> usize {
    let mut delivered = 0;
    for event in events {
        match backend.send_input(event).await {
            Ok(()) => delivered += 1,
            Err(e) => {
                debug!(session_id, error = %e, "synthetic input release failed (#3402)");
            }
        }
    }
    delivered
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(code: &str, pressed: bool) -> InputEvent {
        InputEvent::Key {
            code: code.to_string(),
            pressed,
        }
    }

    fn pointer(x: u32, y: u32, buttons: u8) -> InputEvent {
        InputEvent::Pointer { x, y, buttons }
    }

    #[test]
    fn press_release_bookkeeping() {
        let mut held = HeldInput::default();
        assert!(held.is_empty());
        held.observe(Some("main"), &key("ShiftLeft", true));
        held.observe(Some("main"), &key("KeyA", true));
        held.observe(Some("main"), &key("KeyA", false));
        assert!(!held.is_empty());
        held.observe(Some("main"), &key("ShiftLeft", false));
        assert!(held.is_empty(), "every press was matched by a release");

        held.observe(Some("main"), &pointer(3, 4, 1));
        assert!(!held.is_empty(), "a pressed button is held");
        held.observe(Some("main"), &pointer(5, 6, 0));
        assert!(held.is_empty(), "button-up clears the held buttons");
    }

    #[test]
    fn a_key_up_for_an_unheld_key_is_harmless() {
        let mut held = HeldInput::default();
        held.observe(None, &key("KeyZ", false));
        assert!(held.is_empty());
    }

    #[test]
    fn release_emits_exact_ups_then_clears() {
        let mut held = HeldInput::default();
        held.observe(Some("main"), &key("ShiftLeft", true));
        held.observe(Some("main"), &key("ControlLeft", true));
        held.observe(Some("main"), &key("ShiftLeft", true)); // auto-repeat
        held.observe(Some("main"), &pointer(10, 20, 0b101));
        held.observe(
            Some("main"),
            &InputEvent::Wheel {
                x: 11,
                y: 21,
                delta_x: 0.0,
                delta_y: 1.0,
            },
        );

        assert_eq!(
            held.take_release_events(),
            vec![
                key("ControlLeft", false),
                key("ShiftLeft", false),
                pointer(11, 21, 0),
            ],
            "one key-up per held key, then one all-buttons-up at the last position"
        );
        assert!(held.is_empty());
        assert_eq!(held.source, None, "the reset state is untagged");
    }

    #[test]
    fn release_is_idempotent() {
        let mut held = HeldInput::default();
        held.observe(Some("main"), &key("AltLeft", true));
        assert_eq!(held.take_release_events().len(), 1);
        assert!(held.take_release_events().is_empty());
        assert!(HeldInput::default().take_release_events().is_empty());
    }

    #[test]
    fn source_tagging_distinguishes_windows() {
        let mut held = HeldInput::default();
        assert!(
            !held.held_by_other_than("win-1"),
            "nothing held is never foreign"
        );
        held.observe(Some("main"), &key("ShiftLeft", true));
        assert!(held.held_by_other_than("win-1"));
        assert!(!held.held_by_other_than("main"));

        let mut untagged = HeldInput::default();
        untagged.observe(None, &key("ShiftLeft", true));
        assert!(
            untagged.held_by_other_than("main"),
            "untagged counts as foreign"
        );
    }
}
