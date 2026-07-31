//! The authoritative, client-scoped broadcast-membership state machine behind
//! the shadow `broadcast@<clientId>` region (#2242, Phase 4 step 5b of #2139,
//! part of #2206 / #2152).
//!
//! Models the broadcast-input membership slice the frontend currently drives
//! (`appStore` `broadcastActive` / `broadcastSourceTabId` / `broadcastScope` /
//! `broadcastTargetTabIds` / `lastBroadcastScope`, #1955 / #1956 / #1958): which
//! tabs receive input mirrored from a source terminal, plus the scope the group
//! was derived from and the last scope remembered for the keyboard toggle. This
//! module owns only the **membership orchestration** state per client — not the
//! input fan-out itself, not the tab tree, and not the resolution of a scope to
//! a concrete tab set (that needs the layout tree, which stays frontend).
//!
//! # Client-scoped — Open Design Decision #4 / #6
//!
//! Broadcast membership is a **per-client input-fan-out overlay over that
//! client's own tabs**, not shared infrastructure. The target ids are tab ids,
//! and a tab tree is per-window (each `appStore` instance owns its own tabs and
//! groups); the source is the terminal focused in *this* window, and two windows
//! can each run an independent broadcast session over their own tabs. It is a
//! property of the viewing client, so the store keys everything by `clientId`
//! and projects one `broadcast@<clientId>` region per client — mirroring the
//! client-scoped `layout` ([`crate::layout::projection`]) and `restore-cohort`
//! ([`crate::restore_cohort_projection`]) regions, and unlike the *shared*
//! `session-lifecycle` region (a session's status is a property of the shared
//! session).
//!
//! # Shadow mode — zero user-facing change
//!
//! This step is deliberately **not authoritative**. The store exists, accepts
//! `broadcast.*` intents, and projects diffs, but nothing in the live UI
//! subscribes to or renders a `broadcast` region, and no frontend code
//! dispatches `broadcast.*` intents yet. The existing `appStore` broadcast
//! reducers remain authoritative. Later steps cut rendering, then the mutations,
//! over to it (keeping the reducers as the parity-safe fallback, per the #2205
//! reframe).
//!
//! ## What stays frontend
//!
//! Three concerns deliberately stay on the frontend at the render/mutation cut,
//! keeping a clean per-domain boundary — each needs the live tab tree/registry
//! that the layout machine, not this one, owns:
//!
//! - **`resolveBroadcastTargetTabIds`.** Turning a `"all"` / `"panel"` scope into
//!   a concrete set of terminal tab ids walks the source tab's own group tree.
//!   The store never resolves a scope; a `broadcast.start` / `broadcast.toggle`
//!   carries the already-resolved target ids.
//! - **`getBroadcastTargetTabIds`.** The connected-terminal filter (only
//!   *connected* terminal tabs receive input) needs live per-tab session status.
//!   The store keeps the raw membership set; the frontend intersects it with its
//!   live connected terminals at the fan-out seam — exactly as the current
//!   `getBroadcastTargetTabIds` re-filters at dispatch time.
//! - **`refreshBroadcastMembership`.** Recomputing membership when a tab opens
//!   during an active broadcast re-derives the set from the scope + tree
//!   (frontend); it reconciles against the projected set with
//!   [`add_target`](BroadcastStore::add_target) / [`remove_target`](BroadcastStore::remove_target)
//!   for the delta, so it needs no dedicated intent (mirroring the restore-cohort
//!   bulk-retry, which likewise reads the projection and re-drives). `"custom"`
//!   never auto-adds, so refresh is a no-op there.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// How the broadcast target group was derived. Mirrors the frontend
/// `BroadcastScope` union (`src/types/terminal.ts`).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum BroadcastScope {
    /// Every terminal tab in the source tab's own group.
    #[default]
    All,
    /// Every terminal tab in the same split panel as the source.
    Panel,
    /// An explicit user selection; membership does not come from the scope.
    Custom,
}

/// One client's broadcast-membership state — the direct mirror of the
/// `appStore` broadcast slice for that window.
#[derive(Clone, Debug)]
struct ClientState {
    /// Whether broadcast mode is active for this client.
    active: bool,
    /// The source terminal tab id (where the user types), or `None` when idle.
    source_tab_id: Option<String>,
    /// The scope the current (or most recent) group was derived from.
    scope: BroadcastScope,
    /// The target tab ids, in insertion order with the source first — mirrors
    /// the frontend `Set<string>` (which includes the source as just another
    /// target so the fan-out loop stays uniform).
    target_tab_ids: Vec<String>,
    /// The last scope used, retained across a stop for the keyboard toggle
    /// (#1958). Never cleared by [`stop`](BroadcastStore::stop).
    last_scope: BroadcastScope,
}

impl Default for ClientState {
    /// The idle baseline — matches the `appStore` initial broadcast state
    /// (`broadcastActive: false`, `broadcastScope: "all"`, empty targets,
    /// `lastBroadcastScope: "all"`).
    fn default() -> Self {
        Self {
            active: false,
            source_tab_id: None,
            scope: BroadcastScope::All,
            target_tab_ids: Vec::new(),
            last_scope: BroadcastScope::All,
        }
    }
}

impl ClientState {
    /// The complete render-ready view model for this client's region.
    fn to_view(&self) -> Value {
        json!({
            "active": self.active,
            "sourceTabId": self.source_tab_id,
            "scope": self.scope,
            "targetTabIds": self.target_tab_ids,
            "lastScope": self.last_scope,
        })
    }
}

/// Append the target ids to `out`, source first, de-duplicating while preserving
/// order — mirrors the frontend `new Set([sourceTabId, ...targetTabIds])`.
fn ordered_targets(source_tab_id: &str, target_tab_ids: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(target_tab_ids.len() + 1);
    out.push(source_tab_id.to_string());
    for id in target_tab_ids {
        if !out.iter().any(|existing| existing == id) {
            out.push(id.clone());
        }
    }
    out
}

/// The shadow broadcast-membership authority. Owns one [`ClientState`] per
/// attached client, keyed by `clientId`; an unknown client is seeded lazily on
/// first touch with the idle baseline. Each client projects its own
/// `broadcast@<clientId>` region.
pub struct BroadcastStore {
    clients: Mutex<HashMap<String, ClientState>>,
}

impl Default for BroadcastStore {
    fn default() -> Self {
        Self::new()
    }
}

impl BroadcastStore {
    /// A store with no clients yet. Regions are seeded lazily per `clientId`.
    pub fn new() -> Self {
        Self {
            clients: Mutex::new(HashMap::new()),
        }
    }

    /// The current render-ready view model for a client (seeding it if unknown):
    /// `{ active, sourceTabId, scope, targetTabIds, lastScope }`.
    ///
    /// Pure with respect to broadcast state (never mutates beyond lazy seeding of
    /// an empty client), so the projector can safely diff two consecutive
    /// snapshots.
    pub fn snapshot(&self, client_id: &str) -> Value {
        self.lock()
            .entry(client_id.to_string())
            .or_default()
            .to_view()
    }

    /// `broadcast.start` — enter broadcast mode with the given scope, source tab,
    /// and (frontend-resolved) target tabs. Mirrors `appStore.startBroadcast`:
    /// activates, records the scope as both the active and the remembered
    /// `lastScope`, and seeds the target set as `{source} ∪ targets` (source
    /// first, de-duplicated).
    pub fn start(
        &self,
        client_id: &str,
        scope: BroadcastScope,
        source_tab_id: &str,
        target_tab_ids: &[String],
    ) {
        let mut clients = self.lock();
        let state = clients.entry(client_id.to_string()).or_default();
        state.active = true;
        state.scope = scope;
        state.last_scope = scope;
        state.source_tab_id = Some(source_tab_id.to_string());
        state.target_tab_ids = ordered_targets(source_tab_id, target_tab_ids);
    }

    /// `broadcast.stop` — leave broadcast mode and clear the source/target
    /// selection. Mirrors `appStore.stopBroadcast`: deactivates, drops the source
    /// and targets, but deliberately **retains** `scope` and `lastScope` so the
    /// keyboard toggle can reuse the last scope (#1958).
    pub fn stop(&self, client_id: &str) {
        let mut clients = self.lock();
        let state = clients.entry(client_id.to_string()).or_default();
        state.active = false;
        state.source_tab_id = None;
        state.target_tab_ids = Vec::new();
    }

    /// `broadcast.toggle` — the pure decision of `appStore.toggleBroadcast`
    /// (#1958): while active, stop (payload ignored); while idle, start with the
    /// provided scope/source/targets. The frontend still owns the parts that need
    /// the live tab tree — picking the focused terminal as the source, the
    /// `"custom" → "all"` scope fallback, resolving the targets, and the
    /// "focus a terminal" hint toast — and passes the resolved values here. When
    /// idle with no source resolved (nothing to broadcast from), this is a no-op.
    pub fn toggle(
        &self,
        client_id: &str,
        scope: BroadcastScope,
        source_tab_id: Option<&str>,
        target_tab_ids: &[String],
    ) {
        let is_active = self
            .lock()
            .get(client_id)
            .map(|s| s.active)
            .unwrap_or(false);
        if is_active {
            self.stop(client_id);
        } else if let Some(source) = source_tab_id {
            self.start(client_id, scope, source, target_tab_ids);
        }
    }

    /// `broadcast.addTarget` — add a tab to the target set. Mirrors
    /// `appStore.addBroadcastTarget`: a pure set-insert (no-op if already
    /// present). Like the reducer it does not itself gate on `active`; the
    /// frontend only issues it during an active broadcast, and the empty idle set
    /// keeps a stray add harmless.
    pub fn add_target(&self, client_id: &str, tab_id: &str) {
        let mut clients = self.lock();
        let state = clients.entry(client_id.to_string()).or_default();
        if !state.target_tab_ids.iter().any(|id| id == tab_id) {
            state.target_tab_ids.push(tab_id.to_string());
        }
    }

    /// `broadcast.removeTarget` — remove a tab from the target set. Mirrors
    /// `appStore.removeBroadcastTarget`: a pure set-delete (no-op if absent).
    pub fn remove_target(&self, client_id: &str, tab_id: &str) {
        let mut clients = self.lock();
        let state = clients.entry(client_id.to_string()).or_default();
        state.target_tab_ids.retain(|id| id != tab_id);
    }

    /// Read a client's `(active, source, scope)` (test/diagnostics helper).
    #[cfg(test)]
    pub fn status(&self, client_id: &str) -> Option<(bool, Option<String>, BroadcastScope)> {
        self.lock()
            .get(client_id)
            .map(|s| (s.active, s.source_tab_id.clone(), s.scope))
    }

    /// Read a client's target tab ids in order (test/diagnostics helper).
    #[cfg(test)]
    pub fn target_tab_ids(&self, client_id: &str) -> Vec<String> {
        self.lock()
            .get(client_id)
            .map(|s| s.target_tab_ids.clone())
            .unwrap_or_default()
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, ClientState>> {
        // Short critical sections only; a poisoned lock means another thread
        // panicked mid-mutation (a bug) — recover rather than cascade.
        self.clients.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
