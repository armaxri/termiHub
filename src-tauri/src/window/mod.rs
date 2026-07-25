//! Multi-window foundation (#1900, epic #1899).
//!
//! Backend authority for multi-window state. Separate native windows are
//! separate JavaScript contexts with no shared store, so the backend — which
//! already owns session state keyed by `session_id` — is the natural home for
//! the cross-window coordination the frontend cannot do itself (concept:
//! `docs/concepts/backlog/multi-window.html` → "State Ownership & Event
//! Retargeting").
//!
//! [`WindowManager`] coordinates three things:
//!
//! * **window labelling** — hands out `win-1`, `win-2`, … labels for new
//!   [`tauri::WebviewWindow`]s. The primary window keeps its declared `"main"`
//!   label.
//! * the **`session_id → owning_window` ownership map** — the single source of
//!   truth for which window renders a session, so a tab is shown in exactly one
//!   window at a time (the claim/release handshake). Ownership is a single
//!   [`HashMap`] entry per session, which makes *two simultaneous owners*
//!   structurally impossible; a session with no entry is simply *unclaimed*
//!   (the legacy single-window case).
//! * a **pending hand-off queue** per window label — a destination window
//!   drains its queued records on boot (`take_pending_handoffs`), mirroring the
//!   existing [`PendingSpawn`](crate::spawn::handler::PendingSpawn) pattern.
//!
//! # Windows vs tab groups (maintainer decision, #1900 / #1899)
//!
//! The concept flags "do windows map onto tab groups?" as an open product
//! question. This foundation proceeds on the concept's **recommended** model: a
//! **window owns sessions** (via this `session_id → window` map), orthogonal to
//! tab groups — a window's frontend store still holds its own `tabGroups[]`, and
//! the backend neither knows nor cares about groups. The ownership map is kept
//! deliberately session-keyed (not group-keyed) so that if the product later
//! decides "a window owns whole tab groups", that layer can be added on top
//! without reshaping this map.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, PoisonError};

use serde::{Deserialize, Serialize};

/// A serialized tab view-model handed from one window to another during a
/// re-parent ("move to window") operation.
///
/// The `tab` payload is an **opaque JSON envelope owned by the frontend** so the
/// tab schema can evolve (child issues #1901–#1905) without touching this
/// backend seam. The backend only ferries it from the source window to the
/// destination window's pending queue.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandoffRecord {
    /// The frontend `TerminalTab` view-model (title, config, `contentType`,
    /// `sessionId`, placement). Opaque to the backend.
    pub tab: serde_json::Value,
}

/// Backend coordinator for windows, session ownership, and tab hand-offs.
#[derive(Default)]
pub struct WindowManager {
    /// Monotonic counter feeding unique `win-N` labels.
    seq: AtomicU32,
    /// `session_id → owning_window_label`. At most one entry per session.
    ownership: Mutex<HashMap<String, String>>,
    /// `window_label → queued hand-off records` awaiting the window's boot/claim.
    pending: Mutex<HashMap<String, Vec<HandoffRecord>>>,
}

/// Recover a lock guard even if a previous holder panicked. Multi-window
/// coordination must never wedge because one operation poisoned a mutex.
fn recover<T>(result: Result<T, PoisonError<T>>) -> T {
    result.unwrap_or_else(PoisonError::into_inner)
}

impl WindowManager {
    /// Create an empty manager (no extra windows, nothing claimed).
    pub fn new() -> Self {
        Self::default()
    }

    /// Allocate the next unique window label (`win-1`, `win-2`, …).
    pub fn next_label(&self) -> String {
        let n = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        format!("win-{n}")
    }

    // ── Ownership map ────────────────────────────────────────────────────

    /// Grant `session_id` to `window_label` (the *grant* side of the handshake).
    ///
    /// Returns the previous owner, if any. Because ownership is a single map
    /// entry, claiming atomically supersedes any prior owner — there is never a
    /// window in which the session is owned by two windows at once.
    pub fn claim(&self, session_id: &str, window_label: &str) -> Option<String> {
        let mut map = recover(self.ownership.lock());
        map.insert(session_id.to_string(), window_label.to_string())
    }

    /// Release `session_id` **only if** it is currently owned by `window_label`.
    ///
    /// Returns `true` if an entry was removed. A release from a non-owner is a
    /// no-op, so a stale/late window cannot orphan a session that another
    /// window has already claimed.
    pub fn release(&self, session_id: &str, window_label: &str) -> bool {
        let mut map = recover(self.ownership.lock());
        match map.get(session_id) {
            Some(owner) if owner == window_label => {
                map.remove(session_id);
                true
            }
            _ => false,
        }
    }

    /// Drop every ownership entry held by `window_label` (e.g. the window was
    /// destroyed). Returns the session ids that were owned by it.
    pub fn release_all_for_window(&self, window_label: &str) -> Vec<String> {
        let mut map = recover(self.ownership.lock());
        let owned: Vec<String> = map
            .iter()
            .filter(|(_, w)| w.as_str() == window_label)
            .map(|(s, _)| s.clone())
            .collect();
        for s in &owned {
            map.remove(s);
        }
        owned
    }

    /// The window currently rendering `session_id`, if any.
    pub fn owner_of(&self, session_id: &str) -> Option<String> {
        recover(self.ownership.lock()).get(session_id).cloned()
    }

    /// Whether `window_label` may issue `resize` for `session_id`.
    ///
    /// `true` when the session is **unclaimed** (legacy single-window: any
    /// window may size it) or owned by exactly this window. This is the guard
    /// that keeps a PTY's single size driven by exactly one window so two
    /// windows never race the backend resize (concept: "Resize is a real
    /// subtlety").
    pub fn may_resize(&self, session_id: &str, window_label: &str) -> bool {
        match self.owner_of(session_id) {
            None => true,
            Some(owner) => owner == window_label,
        }
    }

    // ── Hand-off queue ───────────────────────────────────────────────────

    /// Queue a hand-off record for `window_label` to drain later.
    pub fn queue_handoff(&self, window_label: &str, record: HandoffRecord) {
        recover(self.pending.lock())
            .entry(window_label.to_string())
            .or_default()
            .push(record);
    }

    /// Take (and clear) all hand-off records queued for `window_label`.
    pub fn take_handoffs(&self, window_label: &str) -> Vec<HandoffRecord> {
        recover(self.pending.lock())
            .remove(window_label)
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(session_id: &str) -> HandoffRecord {
        HandoffRecord {
            tab: serde_json::json!({ "sessionId": session_id }),
        }
    }

    #[test]
    fn next_label_is_monotonic_and_unique() {
        let wm = WindowManager::new();
        let a = wm.next_label();
        let b = wm.next_label();
        let c = wm.next_label();
        assert_eq!(a, "win-1");
        assert_eq!(b, "win-2");
        assert_eq!(c, "win-3");
    }

    #[test]
    fn claim_records_owner_and_returns_previous() {
        let wm = WindowManager::new();
        assert_eq!(wm.owner_of("s1"), None, "unclaimed session has no owner");
        assert_eq!(wm.claim("s1", "main"), None, "first claim has no previous");
        assert_eq!(wm.owner_of("s1"), Some("main".to_string()));
    }

    #[test]
    fn claim_supersedes_previous_owner_never_two_owners() {
        let wm = WindowManager::new();
        wm.claim("s1", "main");
        // Re-parenting: window win-1 grabs the session.
        let previous = wm.claim("s1", "win-1");
        assert_eq!(previous, Some("main".to_string()));
        // Exactly one owner at all times — the map has a single entry.
        assert_eq!(wm.owner_of("s1"), Some("win-1".to_string()));
    }

    #[test]
    fn claim_release_handshake_never_leaves_zero_owners_mid_move() {
        let wm = WindowManager::new();
        wm.claim("s1", "main");
        // Destination grants first (per the handshake), so the session always
        // has exactly one owner across the move — never zero.
        assert_eq!(wm.owner_of("s1"), Some("main".to_string()));
        wm.claim("s1", "win-1");
        assert_eq!(wm.owner_of("s1"), Some("win-1".to_string()));
        // The source's late release for its old ownership is now a no-op —
        // it does not own the session any more, so it cannot orphan it.
        assert!(!wm.release("s1", "main"));
        assert_eq!(wm.owner_of("s1"), Some("win-1".to_string()));
    }

    #[test]
    fn release_by_owner_clears_but_non_owner_is_noop() {
        let wm = WindowManager::new();
        wm.claim("s1", "win-1");
        assert!(!wm.release("s1", "win-2"), "non-owner release is a no-op");
        assert_eq!(wm.owner_of("s1"), Some("win-1".to_string()));
        assert!(wm.release("s1", "win-1"), "owner release clears");
        assert_eq!(wm.owner_of("s1"), None);
        assert!(!wm.release("s1", "win-1"), "double release is a no-op");
    }

    #[test]
    fn release_all_for_window_drops_only_that_windows_sessions() {
        let wm = WindowManager::new();
        wm.claim("s1", "win-1");
        wm.claim("s2", "win-1");
        wm.claim("s3", "main");
        let mut dropped = wm.release_all_for_window("win-1");
        dropped.sort();
        assert_eq!(dropped, vec!["s1".to_string(), "s2".to_string()]);
        assert_eq!(wm.owner_of("s1"), None);
        assert_eq!(wm.owner_of("s2"), None);
        assert_eq!(wm.owner_of("s3"), Some("main".to_string()));
    }

    #[test]
    fn may_resize_allows_unclaimed_and_owner_only() {
        let wm = WindowManager::new();
        // Unclaimed: any window may size it (legacy single-window behaviour).
        assert!(wm.may_resize("s1", "main"));
        assert!(wm.may_resize("s1", "win-1"));
        // Once claimed, only the owner may size it — no two-window race.
        wm.claim("s1", "win-1");
        assert!(wm.may_resize("s1", "win-1"));
        assert!(!wm.may_resize("s1", "main"));
    }

    #[test]
    fn handoff_queue_is_drained_once_per_window() {
        let wm = WindowManager::new();
        wm.queue_handoff("win-1", record("s1"));
        wm.queue_handoff("win-1", record("s2"));
        wm.queue_handoff("win-2", record("s3"));

        let taken = wm.take_handoffs("win-1");
        assert_eq!(taken.len(), 2);
        // A second drain yields nothing — records are taken, not copied.
        assert!(wm.take_handoffs("win-1").is_empty());
        // A different window's queue is untouched.
        assert_eq!(wm.take_handoffs("win-2").len(), 1);
        // An unknown window simply has an empty queue.
        assert!(wm.take_handoffs("win-99").is_empty());
    }
}
