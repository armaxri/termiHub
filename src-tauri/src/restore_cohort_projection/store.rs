//! The authoritative, client-scoped restore-cohort state machine behind the
//! shadow `restore-cohort@<clientId>` region (#2206, Phase 4 step 5 of #2139).
//!
//! Models the aggregate restore/launch feedback the frontend currently drives
//! (`appStore` `restoreCohort` + `failedRestoreTabIds`, #1146 / #1227): a cohort
//! of tab ids placed by one restore, settled tab-by-tab, that raises a single
//! summary and remembers which tabs failed so they can be bulk-reconnected. This
//! module owns only the cohort **orchestration** state per client — not tab
//! content, not layout, not the restore *decision* logic (that is the pure
//! `termihub_core::restore_mode` engine, #2145, served as query commands).
//!
//! # Client-scoped — Open Design Decision #4 / #6
//!
//! A restore cohort belongs to the client that launched the restore: each window
//! restores its own layout, raises its own summary toast, and retries its own
//! failed tabs. It is a property of the viewing client, not of shared
//! infrastructure, so the store keys everything by `clientId` and projects one
//! `restore-cohort@<clientId>` region per client — mirroring `layout`.
//!
//! # Shadow mode — zero user-facing change
//!
//! This step is deliberately **not authoritative**. The store exists, accepts
//! `restore.*` intents, and projects diffs, but nothing in the live UI
//! subscribes to or renders a `restore-cohort` region, and no frontend code
//! dispatches `restore.*` intents yet. The `appStore` cohort reducers and the
//! toast feedback remain authoritative.
//!
//! ## What stays frontend
//!
//! Two concerns deliberately stay on the frontend at the render/mutation cut,
//! keeping a clean per-domain boundary:
//!
//! - **The toast itself.** The store produces the *settlement summary*
//!   ([`CohortSettlement`], carrying a monotonic `seq` so a render can fire the
//!   toast exactly once per new settle); rendering that summary as a `sonner`
//!   toast is presentation.
//! - **The live-terminal filter.** `settleRestoreCohort` /
//!   `reconnectFailedRestoreTabs` restrict the retry set to tab ids that still
//!   exist as *live terminal tabs* — which needs the tab registry that lives
//!   frontend-side. The store keeps the raw failed-tab set; the frontend
//!   intersects it with the live tabs when it renders the retry action and when
//!   it re-drives, exactly as the current `reconnectFailedRestoreTabs` re-filters
//!   at click time.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The outcome of settling one tab of a cohort.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TabOutcome {
    /// The tab's session connected.
    Connected,
    /// The tab's session failed to connect.
    Failed,
}

/// An in-flight restore/launch cohort: the tabs still connecting, plus the
/// running tallies used to build the summary once they all settle.
#[derive(Clone, Debug, Default, PartialEq)]
struct Cohort {
    /// Tab ids still waiting to connect or fail, in insertion order.
    pending: Vec<String>,
    /// Total tabs the cohort covers (`pending.len()` at start + `preFailedCount`).
    total: usize,
    /// How many tabs have failed so far (seeded with the pre-failed count).
    failed: usize,
    /// The tab ids that failed, in settle order — feeds the bulk-retry control.
    failed_tab_ids: Vec<String>,
    /// A pending toast id this cohort resolves in place on settle, if any.
    toast_id: Option<String>,
}

impl Cohort {
    /// The render-ready view of the in-flight cohort.
    fn to_view(&self) -> Value {
        json!({
            "pending": self.pending,
            "total": self.total,
            "failed": self.failed,
            "failedTabIds": self.failed_tab_ids,
            "toastId": self.toast_id,
        })
    }
}

/// The summary of a settled cohort — the render-cut seam that drives the single
/// aggregate toast. `seq` increments per settle so a subscriber can raise the
/// toast exactly once per new settlement and ignore unchanged republishes.
#[derive(Clone, Debug, PartialEq)]
struct CohortSettlement {
    /// Monotonic settle counter for this client (starts at 1).
    seq: u64,
    /// Total tabs the settled cohort covered.
    total: usize,
    /// How many connected (`total - failed`).
    restored: usize,
    /// How many failed.
    failed: usize,
    /// The failed tab ids offered for bulk retry (raw; the frontend intersects
    /// with its live terminal tabs before rendering the action / re-driving).
    retry_tab_ids: Vec<String>,
    /// The toast id to resolve in place, if the cohort carried one.
    toast_id: Option<String>,
}

impl CohortSettlement {
    fn to_view(&self) -> Value {
        json!({
            "seq": self.seq,
            "total": self.total,
            "restored": self.restored,
            "failed": self.failed,
            "retryTabIds": self.retry_tab_ids,
            "toastId": self.toast_id,
        })
    }
}

/// One client's restore-cohort state.
#[derive(Clone, Debug, Default)]
struct ClientState {
    /// The in-flight cohort, or `None` when no restore/launch is settling.
    cohort: Option<Cohort>,
    /// Failed terminal tab ids captured from the most recently settled cohort;
    /// drives the bulk "Reconnect failed tabs" control (#1227). Cleared when a
    /// fresh cohort begins.
    failed_restore_tab_ids: Vec<String>,
    /// The most recent settlement summary (the toast seam), or `None` before the
    /// first settle. Monotonic `seq` lets a render fire once per new settle.
    settlement: Option<CohortSettlement>,
    /// The running settle counter feeding [`CohortSettlement::seq`].
    settle_seq: u64,
}

impl ClientState {
    /// The complete render-ready view model for this client's region.
    fn to_view(&self) -> Value {
        json!({
            "cohort": self.cohort.as_ref().map(Cohort::to_view),
            "failedTabIds": self.failed_restore_tab_ids,
            "settlement": self.settlement.as_ref().map(CohortSettlement::to_view),
        })
    }
}

/// The shadow restore-cohort authority. Owns one [`ClientState`] per attached
/// client, keyed by `clientId`; an unknown client is seeded lazily on first
/// touch. Each client projects its own `restore-cohort@<clientId>` region.
pub struct RestoreCohortStore {
    clients: Mutex<HashMap<String, ClientState>>,
}

impl Default for RestoreCohortStore {
    fn default() -> Self {
        Self::new()
    }
}

impl RestoreCohortStore {
    /// A store with no clients yet. Regions are seeded lazily per `clientId`.
    pub fn new() -> Self {
        Self {
            clients: Mutex::new(HashMap::new()),
        }
    }

    /// The current render-ready view model for a client (seeding it if unknown):
    /// `{ cohort, failedTabIds, settlement }`.
    ///
    /// Pure with respect to cohort state (never mutates beyond lazy seeding of an
    /// empty client), so the projector can safely diff two consecutive snapshots.
    pub fn snapshot(&self, client_id: &str) -> Value {
        self.lock()
            .entry(client_id.to_string())
            .or_default()
            .to_view()
    }

    /// `restore.beginCohort` — register the cohort of tabs placed by one
    /// restore/launch. `pending_tab_ids` are the live tabs to wait on;
    /// `pre_failed_count` are tabs that failed before the cohort began (e.g. an
    /// agent-resolution error). A fresh cohort supersedes any leftover retry set.
    ///
    /// A cohort with `total == 0` (nothing pending, none pre-failed) is a
    /// complete no-op, matching the frontend's early return. A cohort with no
    /// live tabs to wait on (all pre-failed) settles immediately.
    pub fn begin_cohort(
        &self,
        client_id: &str,
        pending_tab_ids: &[String],
        pre_failed_count: usize,
        toast_id: Option<String>,
    ) {
        // De-duplicate while preserving order (mirrors the TS `Set`).
        let mut pending: Vec<String> = Vec::with_capacity(pending_tab_ids.len());
        for id in pending_tab_ids {
            if !pending.contains(id) {
                pending.push(id.clone());
            }
        }
        let total = pending.len() + pre_failed_count;
        if total == 0 {
            return;
        }
        let no_live = pending.is_empty();
        {
            let mut clients = self.lock();
            let state = clients.entry(client_id.to_string()).or_default();
            state.cohort = Some(Cohort {
                pending,
                total,
                failed: pre_failed_count,
                failed_tab_ids: Vec::new(),
                toast_id,
            });
            state.failed_restore_tab_ids = Vec::new();
        }
        // A cohort with no live tabs to wait on settles now.
        if no_live {
            self.settle_cohort(client_id);
        }
    }

    /// `restore.settleTab` — settle one tab of the active cohort. Ignores a tab
    /// that is not pending in the current cohort (no cohort, or a stray/duplicate
    /// settle). When the last pending tab settles, the cohort summary is raised.
    pub fn settle_tab(&self, client_id: &str, tab_id: &str, outcome: TabOutcome) {
        let emptied = {
            let mut clients = self.lock();
            let Some(state) = clients.get_mut(client_id) else {
                return;
            };
            let Some(cohort) = state.cohort.as_mut() else {
                return;
            };
            let Some(pos) = cohort.pending.iter().position(|id| id == tab_id) else {
                return;
            };
            cohort.pending.remove(pos);
            if outcome == TabOutcome::Failed {
                cohort.failed += 1;
                if !cohort.failed_tab_ids.iter().any(|id| id == tab_id) {
                    cohort.failed_tab_ids.push(tab_id.to_string());
                }
            }
            cohort.pending.is_empty()
        };
        if emptied {
            self.settle_cohort(client_id);
        }
    }

    /// Raise the aggregate summary for a settled cohort and clear it. Records the
    /// failed-tab set as [`ClientState::failed_restore_tab_ids`] (raw — the
    /// frontend intersects with its live terminal tabs) and bumps the monotonic
    /// settlement `seq` so a subscriber fires the toast exactly once. Clearing
    /// the cohort first makes this fire exactly once even if a stray settle
    /// races in. Idempotent when there is no cohort.
    fn settle_cohort(&self, client_id: &str) {
        let mut clients = self.lock();
        let Some(state) = clients.get_mut(client_id) else {
            return;
        };
        let Some(cohort) = state.cohort.take() else {
            return;
        };
        state.failed_restore_tab_ids = cohort.failed_tab_ids.clone();
        state.settle_seq += 1;
        state.settlement = Some(CohortSettlement {
            seq: state.settle_seq,
            total: cohort.total,
            restored: cohort.total.saturating_sub(cohort.failed),
            failed: cohort.failed,
            retry_tab_ids: cohort.failed_tab_ids,
            toast_id: cohort.toast_id,
        });
    }

    /// Read a client's in-flight cohort tallies (test/diagnostics helper):
    /// `(total, pending, failed)`.
    #[cfg(test)]
    pub fn cohort_tallies(&self, client_id: &str) -> Option<(usize, usize, usize)> {
        self.lock()
            .get(client_id)
            .and_then(|s| s.cohort.as_ref())
            .map(|c| (c.total, c.pending.len(), c.failed))
    }

    /// Read a client's captured failed-restore tab ids (test/diagnostics helper).
    #[cfg(test)]
    pub fn failed_restore_tab_ids(&self, client_id: &str) -> Vec<String> {
        self.lock()
            .get(client_id)
            .map(|s| s.failed_restore_tab_ids.clone())
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
