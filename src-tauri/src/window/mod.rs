//! Multi-window foundation (#1900, epic #1899).
//!
//! Backend authority for multi-window state. Separate native windows are
//! separate JavaScript contexts with no shared store, so the backend — which
//! already owns session state keyed by `session_id` — is the natural home for
//! the cross-window coordination the frontend cannot do itself (concept:
//! `docs/concepts/implemented/multi-window.html` → "State Ownership & Event
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

/// Runtime label of the primary application window (mirrors the frontend
/// `MAIN_WINDOW_LABEL`). Used to order the primary window first when assembling a
/// multi-window persisted layout, and to gate the "layout changed" nudge so the
/// main window never nudges itself into a re-save loop (#1925).
pub const MAIN_WINDOW_LABEL: &str = "main";

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
    /// `window_label → the window's live tab count`, last reported by that
    /// window (#1910). Tabs live in a window's own JS context, so a window
    /// cannot see another window's count; each window reports its own here and
    /// the "Move to Window ▸" picker reads the map to show a per-window "N tabs"
    /// hint sourced from real state rather than a placeholder. Absent until a
    /// window first reports (a freshly-booted window that has not yet reported).
    tab_counts: Mutex<HashMap<String, usize>>,
    /// `window_label → the window's last-reported captured layout slice` — the
    /// aggregation authority for multi-window persistence (#1925). Each window's
    /// tab groups live in its own JS context, so the main window cannot see
    /// another window's layout; every window reports its own slice here and the
    /// main window assembles the full last-session / workspace document from
    /// [`Self::collect_layouts`].
    layouts: Mutex<HashMap<String, StoredLayout>>,
    /// Monotonic counter giving each first-seen window a stable collect order so
    /// [`Self::collect_layouts`] returns windows deterministically.
    layout_seq: AtomicU32,
    /// `window_label → tab groups to hydrate on boot` for a window spawned by a
    /// multi-window restore (#1925). Mirrors [`Self::pending`] (hand-offs) but
    /// carries whole tab groups seeded by the restore rather than one moved tab.
    pending_restores: Mutex<HashMap<String, serde_json::Value>>,
}

/// One window's reported layout slice, held by [`WindowManager`] for the main
/// window to assemble into the full multi-window persisted document (#1925).
#[derive(Debug, Clone)]
struct StoredLayout {
    /// The window's captured `WorkspaceTabGroupDef[]` (opaque frontend JSON).
    tab_groups: serde_json::Value,
    /// Index of the active group within this window's own groups.
    active_group_index: usize,
    /// First-report order, for a deterministic secondary-window ordering.
    order: u32,
}

/// One window's reported layout slice as returned to the frontend for assembly
/// (#1925). The `tab_groups` payload is opaque frontend JSON.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowLayoutReport {
    /// The reporting window's runtime label (`main`, `win-1`, …).
    pub label: String,
    /// That window's captured `WorkspaceTabGroupDef[]` (opaque frontend JSON).
    pub tab_groups: serde_json::Value,
    /// Index of the active group within this window's own groups.
    pub active_group_index: usize,
}

/// Recover a lock guard even if a previous holder panicked. Multi-window
/// coordination must never wedge because one operation poisoned a mutex.
fn recover<T>(result: Result<T, PoisonError<T>>) -> T {
    result.unwrap_or_else(PoisonError::into_inner)
}

// ── Per-OS window-close / quit policy (#1903) ────────────────────────────────
//
// With one window, "window closed" ≈ "app quit". Multi-window breaks that
// identity, so the last-window-close behaviour must follow platform convention
// (concept: `docs/concepts/implemented/multi-window.html` → "Per-Platform
// Constraints"). These are pure, `#[cfg]`-gated decisions so the branches are
// unit-testable without a running event loop; `lib.rs` calls them from the
// `RunEvent` handler.

/// Whether app-wide teardown (tunnels, embedded/X servers, transfers, SFTP)
/// should run when the **last** window is destroyed.
///
/// - **Windows/Linux**: closing the last window quits the app, so tear down now.
/// - **macOS**: the app stays alive in the Dock (WKWebView convention), so
///   teardown is deferred to an actual quit ([`should_prevent_exit`] returns
///   `false` for an explicit exit) rather than run on window close.
pub fn should_teardown_on_last_window() -> bool {
    cfg!(not(target_os = "macos"))
}

/// Whether an `ExitRequested` should be prevented to keep the app running.
///
/// - **macOS**: a user-triggered exit (last window closed → `code == None`)
///   keeps the app alive in the Dock; an explicit programmatic quit
///   (`code == Some`, e.g. the app menu's Quit / `AppHandle::exit`) always
///   proceeds.
/// - **Windows/Linux**: never stays alive — the exit always proceeds.
pub fn should_prevent_exit(code: Option<i32>) -> bool {
    cfg!(target_os = "macos") && code.is_none()
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

    /// A snapshot of the full `session_id → owning_window_label` map.
    ///
    /// The Open Connections panel reads this once when it opens to stamp each
    /// session row with the window that owns it (#1926). Since #1939 every window
    /// claims the sessions it renders (on open/attach/restore, not only on a
    /// hand-off), so this normally covers every live session; a session still
    /// carries no entry only in the brief window before its rendering tab has
    /// claimed it, and the panel renders no window badge for it until then.
    pub fn all_owners(&self) -> HashMap<String, String> {
        recover(self.ownership.lock()).clone()
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

    // ── Per-window tab count (#1910) ─────────────────────────────────────

    /// Record `window_label`'s current tab count, as reported by that window.
    ///
    /// Each window owns its own tab set in a separate JS context, so it reports
    /// its count here whenever the count changes; the "Move to Window ▸" picker
    /// in every *other* window reads it back via [`Self::tab_count_of`].
    pub fn set_tab_count(&self, window_label: &str, count: usize) {
        recover(self.tab_counts.lock()).insert(window_label.to_string(), count);
    }

    /// The last tab count reported by `window_label`, or `None` if it has not
    /// reported yet (a window that just booted and has not drawn its tabs).
    pub fn tab_count_of(&self, window_label: &str) -> Option<usize> {
        recover(self.tab_counts.lock()).get(window_label).copied()
    }

    /// Forget a window's reported tab count (the window was destroyed), so the
    /// map never grows a stale entry for a window that no longer exists.
    pub fn forget_tab_count(&self, window_label: &str) {
        recover(self.tab_counts.lock()).remove(window_label);
    }

    // ── Per-window layout aggregation for persistence (#1925) ─────────────

    /// Record `window_label`'s current captured layout slice for the main window
    /// to aggregate into a multi-window persisted document.
    ///
    /// Returns whether the stored slice actually *changed*. The caller uses this
    /// to nudge the main window to re-persist only on a real change — never on a
    /// redundant re-report of an unchanged layout, which would otherwise loop the
    /// main window's re-save.
    pub fn report_layout(
        &self,
        window_label: &str,
        tab_groups: serde_json::Value,
        active_group_index: usize,
    ) -> bool {
        let mut map = recover(self.layouts.lock());
        let changed = match map.get(window_label) {
            Some(existing) => {
                existing.tab_groups != tab_groups
                    || existing.active_group_index != active_group_index
            }
            None => true,
        };
        // Preserve a window's first-seen order across re-reports so the collect
        // order is stable while it stays open.
        let order = map
            .get(window_label)
            .map(|l| l.order)
            .unwrap_or_else(|| self.layout_seq.fetch_add(1, Ordering::SeqCst));
        map.insert(
            window_label.to_string(),
            StoredLayout {
                tab_groups,
                active_group_index,
                order,
            },
        );
        changed
    }

    /// Forget a window's reported layout slice (the window was destroyed) so an
    /// assembled document never carries a window that no longer exists.
    pub fn forget_layout(&self, window_label: &str) {
        recover(self.layouts.lock()).remove(window_label);
    }

    /// Every window's reported layout slice, ordered main-window-first then by
    /// first-report order, for the main window to assemble the full document.
    pub fn collect_layouts(&self) -> Vec<WindowLayoutReport> {
        let map = recover(self.layouts.lock());
        let mut entries: Vec<(&String, &StoredLayout)> = map.iter().collect();
        entries.sort_by(|(la, a), (lb, b)| {
            let a_main = la.as_str() == MAIN_WINDOW_LABEL;
            let b_main = lb.as_str() == MAIN_WINDOW_LABEL;
            // Main first (a_main "greater"), then by first-report order.
            b_main.cmp(&a_main).then_with(|| a.order.cmp(&b.order))
        });
        entries
            .into_iter()
            .map(|(label, l)| WindowLayoutReport {
                label: label.clone(),
                tab_groups: l.tab_groups.clone(),
                active_group_index: l.active_group_index,
            })
            .collect()
    }

    // ── Pending window-restore queue (#1925) ─────────────────────────────

    /// Queue the tab groups a restore-spawned window should hydrate on boot.
    pub fn queue_restore(&self, window_label: &str, groups: serde_json::Value) {
        recover(self.pending_restores.lock()).insert(window_label.to_string(), groups);
    }

    /// Take (and clear) the restore payload queued for `window_label`, if any.
    pub fn take_restore(&self, window_label: &str) -> Option<serde_json::Value> {
        recover(self.pending_restores.lock()).remove(window_label)
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
    fn all_owners_snapshots_the_full_ownership_map() {
        let wm = WindowManager::new();
        assert!(wm.all_owners().is_empty(), "no claims → empty snapshot");
        wm.claim("s1", "win-1");
        wm.claim("s2", "win-1");
        wm.claim("s3", "main");
        let owners = wm.all_owners();
        assert_eq!(owners.len(), 3);
        assert_eq!(owners.get("s1"), Some(&"win-1".to_string()));
        assert_eq!(owners.get("s2"), Some(&"win-1".to_string()));
        assert_eq!(owners.get("s3"), Some(&"main".to_string()));
        // The snapshot is a copy — mutating the manager does not change it.
        wm.release("s1", "win-1");
        assert_eq!(
            owners.get("s1"),
            Some(&"win-1".to_string()),
            "snapshot is detached from later releases"
        );
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
    fn broadened_claim_keeps_single_window_resize_and_single_owner_on_move() {
        // #1939: every window now claims the sessions it renders, so a session in
        // a lone window is *claimed* (by "main") rather than left unclaimed. This
        // must not change single-window resize gating: the owning window still
        // resizes it.
        let wm = WindowManager::new();
        assert_eq!(
            wm.claim("s1", "main"),
            None,
            "first render claims the session"
        );
        assert!(
            wm.may_resize("s1", "main"),
            "the sole window that rendered (and claimed) the session still resizes it"
        );

        // A move re-parents the session: the destination grants first, so there is
        // never a moment with two owners, and the source's later release is a
        // no-op that cannot orphan the moved session.
        assert_eq!(
            wm.claim("s1", "win-1"),
            Some("main".to_string()),
            "destination supersedes the previous owner atomically"
        );
        assert_eq!(wm.owner_of("s1"), Some("win-1".to_string()));
        assert!(!wm.release("s1", "main"), "stale source release is a no-op");
        assert_eq!(
            wm.owner_of("s1"),
            Some("win-1".to_string()),
            "single-owner invariant holds across the move"
        );
        // Resize gating followed ownership to the destination.
        assert!(wm.may_resize("s1", "win-1"));
        assert!(!wm.may_resize("s1", "main"));

        // Closing the tab in the owning window relinquishes ownership.
        assert!(wm.release("s1", "win-1"), "owner release clears the entry");
        assert_eq!(wm.owner_of("s1"), None);
    }

    #[test]
    fn last_window_teardown_policy_is_per_os() {
        // macOS keeps the app alive on last-window-close, so teardown is
        // deferred; every other platform tears down when the last window goes.
        if cfg!(target_os = "macos") {
            assert!(!should_teardown_on_last_window());
        } else {
            assert!(should_teardown_on_last_window());
        }
    }

    #[test]
    fn prevent_exit_only_on_macos_user_triggered_close() {
        if cfg!(target_os = "macos") {
            // Last window closed (no explicit code) → stay alive in the Dock.
            assert!(should_prevent_exit(None));
            // Explicit quit (menu Quit / AppHandle::exit) → proceed.
            assert!(!should_prevent_exit(Some(0)));
        } else {
            // Windows/Linux never stay alive.
            assert!(!should_prevent_exit(None));
            assert!(!should_prevent_exit(Some(0)));
        }
    }

    #[test]
    fn tab_count_is_reported_read_back_and_forgotten() {
        let wm = WindowManager::new();
        // Unreported window has no count (freshly booted, tabs not yet drawn).
        assert_eq!(wm.tab_count_of("win-1"), None);

        wm.set_tab_count("win-1", 2);
        wm.set_tab_count("main", 0);
        assert_eq!(wm.tab_count_of("win-1"), Some(2));
        assert_eq!(
            wm.tab_count_of("main"),
            Some(0),
            "zero is 'empty', not absent"
        );

        // A re-report overwrites the previous value.
        wm.set_tab_count("win-1", 5);
        assert_eq!(wm.tab_count_of("win-1"), Some(5));

        // Forgetting a destroyed window drops only its entry.
        wm.forget_tab_count("win-1");
        assert_eq!(wm.tab_count_of("win-1"), None);
        assert_eq!(wm.tab_count_of("main"), Some(0));
    }

    #[test]
    fn report_layout_reports_signals_change_and_forgets() {
        let wm = WindowManager::new();
        let groups = |n: &str| serde_json::json!([{ "name": n }]);

        // First report of a window is always a change.
        assert!(wm.report_layout("main", groups("a"), 0));
        // Re-reporting the identical slice is not a change (prevents re-save loop).
        assert!(!wm.report_layout("main", groups("a"), 0));
        // A different slice — or a different active index — is a change.
        assert!(wm.report_layout("main", groups("b"), 0));
        assert!(wm.report_layout("main", groups("b"), 1));

        // Forgetting a destroyed window drops its slice; a later report is "new".
        wm.forget_layout("main");
        assert!(wm.report_layout("main", groups("b"), 1));
    }

    #[test]
    fn collect_layouts_orders_main_first_then_first_report_order() {
        let wm = WindowManager::new();
        let groups = |n: &str| serde_json::json!([{ "name": n }]);

        // Report secondaries before main to prove main is floated to the front.
        wm.report_layout("win-2", groups("b"), 0);
        wm.report_layout("win-1", groups("c"), 0);
        wm.report_layout("main", groups("a"), 0);

        let collected: Vec<String> = wm.collect_layouts().into_iter().map(|r| r.label).collect();
        // Main first, then secondaries in first-report order (win-2 before win-1).
        assert_eq!(collected, vec!["main", "win-2", "win-1"]);

        // A window keeps its order across re-reports.
        wm.report_layout("win-2", groups("b2"), 0);
        let collected: Vec<String> = wm.collect_layouts().into_iter().map(|r| r.label).collect();
        assert_eq!(collected, vec!["main", "win-2", "win-1"]);
    }

    #[test]
    fn pending_restore_is_queued_and_drained_once() {
        let wm = WindowManager::new();
        let payload = serde_json::json!({ "tabGroups": [{ "name": "g" }] });
        assert_eq!(
            wm.take_restore("win-1"),
            None,
            "unseeded window has nothing"
        );

        wm.queue_restore("win-1", payload.clone());
        assert_eq!(wm.take_restore("win-1"), Some(payload));
        // Drained, not copied — a second take is empty.
        assert_eq!(wm.take_restore("win-1"), None);
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
