//! "A remote agent crashed since it was last connected" notice (#3593, OBS-010).
//!
//! After an agent connects — the first connect and every in-task reconnect —
//! the desktop asks it once for `agent.crash_reports.list` over the **existing**
//! agent connection. The call is spawned off the connect path (a connect is
//! never delayed or failed by it), bounded by
//! [`AGENT_REPORT_TIMEOUT`](super::agent_crash_reports::AGENT_REPORT_TIMEOUT),
//! and skipped silently for an agent that predates the method ("method not
//! found") or fails. Nothing here opens a connection or talks to another host.
//!
//! # "New since last connect"
//!
//! The desktop remembers, per agent id, the newest report name it has already
//! seen, in the small backend-owned store [`SEEN_STORE_FILE`] in the config
//! directory. Report names are `crash-YYYYMMDDTHHMMSSZ-<pid>.txt` and sort
//! chronologically, the same ordering the local `.notified` marker in
//! `core::diagnostics::crash_report` relies on. A listed report whose name sorts
//! after the remembered one is new. No agent protocol change is needed and the
//! agent's reports are never modified.
//!
//! **First check of an agent** (no entry yet — a newly added agent, or the
//! first connect after upgrading to a desktop with this feature): the reports it
//! lists are taken as the baseline and treated as seen, so an agent carrying up
//! to 30 days of old reports does not raise a notice for crashes that may long
//! predate the user's previous session. Only crashes after that first check
//! raise a notice; the older ones stay available in Export Diagnostics.
//!
//! A notice stays pending (and is re-sent on later reconnects) until the user
//! acts on it; acknowledging records the report as seen, so the same crash is
//! never announced twice. One notice per agent aggregates its new reports.
//!
//! # Not part of backups
//!
//! The store is **not** a backup section: it is a per-machine "what did this
//! desktop already show" cursor, not user configuration. Restoring it onto
//! another machine would suppress notices that machine never showed, and losing
//! it only re-baselines (the next connect records the current reports as seen,
//! without a notice) — it is cheap to rebuild and carries no user intent.
//!
//! The check honours the `showCrashReportNotice` setting: when the user opted
//! out, no call is made at all.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use termihub_core::diagnostics::crash_report::{self, MAX_REMOTE_REPORTS};
use termihub_core::protocol::methods::{CrashReportsListResult, AGENT_CRASH_REPORTS_LIST};

use super::agent_crash_reports::{AgentCallError, AgentReportSource, ConnectedAgents};
use crate::terminal::agent_manager::AgentRpcClient;
use crate::utils::fs::write_atomic;
use crate::utils::migrate::{guard_not_newer, load_versioned, LoadOutcome, VersionedStore};

/// File (in the config directory) holding the newest seen report per agent.
pub const SEEN_STORE_FILE: &str = "agent-crash-reports-seen.json";

/// Tauri event carrying the full list of pending agent crash notices whenever
/// it changes.
pub const AGENT_CRASH_NOTICES_EVENT: &str = "agent-crash-notices-changed";

/// Settings key of the crash-notice opt-out shared with the local notice.
const SHOW_NOTICE_SETTING: &str = "showCrashReportNotice";

/// What the desktop has already seen of one agent's crash reports.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeenAgent {
    /// Newest report name already seen; `None` when the agent had none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub newest_seen: Option<String>,
}

/// On-disk shape of [`SEEN_STORE_FILE`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeenStore {
    /// Schema version.
    pub version: String,
    /// Keyed by agent id. An entry's presence means "checked before".
    #[serde(default)]
    pub agents: BTreeMap<String, SeenAgent>,
    /// Unknown top-level keys, kept so an older app does not drop them.
    #[serde(flatten, default)]
    pub extra: serde_json::Map<String, Value>,
}

impl Default for SeenStore {
    fn default() -> Self {
        Self {
            version: <Self as VersionedStore>::CURRENT_VERSION.to_string(),
            agents: BTreeMap::new(),
            extra: serde_json::Map::new(),
        }
    }
}

impl VersionedStore for SeenStore {
    const STORE_NAME: &'static str = SEEN_STORE_FILE;
    const CURRENT_VERSION: u32 = 1;
}

/// One pending notice: an agent with crash reports newer than the last seen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCrashNotice {
    /// The agent's id (the frontend maps it to a display name).
    pub agent_id: String,
    /// Newest new report (pass to `read_agent_crash_report`).
    pub name: String,
    /// How many reports are new since the last acknowledgement.
    pub new_count: usize,
}

/// Outcome of comparing one listing with what was seen before.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// First check of this agent: remember `newest` as seen, show nothing.
    Baseline { newest: Option<String> },
    /// Reports newer than the last seen one exist.
    Notify { newest: String, new_count: usize },
    /// Nothing new.
    NothingNew,
}

/// Decide what a listing of `names` (validated report names, any order) means
/// given what was `seen` of the agent before (`None` = never checked).
pub fn decide(seen: Option<&SeenAgent>, names: &[String]) -> Decision {
    let newest = names.iter().max().cloned();
    let Some(seen) = seen else {
        return Decision::Baseline { newest };
    };
    let new: Vec<&String> = names
        .iter()
        .filter(|n| seen.newest_seen.as_ref().is_none_or(|s| *n > s))
        .collect();
    match new.iter().max() {
        Some(newest) => Decision::Notify {
            newest: (*newest).clone(),
            new_count: new.len(),
        },
        None => Decision::NothingNew,
    }
}

struct Inner {
    /// Loaded lazily on first use.
    seen: Option<SeenStore>,
    /// `false` when the file was written by a newer version: never overwrite.
    writable: bool,
    pending: BTreeMap<String, AgentCrashNotice>,
}

/// Holds the seen-store and the pending notices (managed Tauri state).
pub struct AgentCrashNoticeService {
    path: PathBuf,
    inner: Mutex<Inner>,
}

impl AgentCrashNoticeService {
    /// A service persisting to [`SEEN_STORE_FILE`] in `config_dir`.
    pub fn new(config_dir: &Path) -> Self {
        Self {
            path: config_dir.join(SEEN_STORE_FILE),
            inner: Mutex::new(Inner {
                seen: None,
                writable: true,
                pending: BTreeMap::new(),
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn loaded<'a>(&self, inner: &'a mut Inner) -> &'a mut SeenStore {
        if inner.seen.is_none() {
            let (store, writable) = self.load();
            inner.writable = writable;
            inner.seen = Some(store);
        }
        inner.seen.get_or_insert_with(SeenStore::default)
    }

    fn load(&self) -> (SeenStore, bool) {
        let Ok(raw) = fs::read_to_string(&self.path) else {
            return (SeenStore::default(), true);
        };
        match load_versioned::<SeenStore>(&raw) {
            LoadOutcome::Loaded { data, .. } => (data, true),
            LoadOutcome::Newer(e) => {
                tracing::warn!("{SEEN_STORE_FILE} is from a newer version, not updating it: {e}");
                (SeenStore::default(), false)
            }
            LoadOutcome::Corrupt(e) => {
                // A lost cursor only re-baselines (no notice), so start over.
                tracing::warn!("{SEEN_STORE_FILE} is unreadable, starting over: {e}");
                (SeenStore::default(), true)
            }
        }
    }

    fn save(&self, inner: &Inner) {
        if !inner.writable {
            return;
        }
        let Some(store) = inner.seen.as_ref() else {
            return;
        };
        let result = guard_not_newer(&self.path, SEEN_STORE_FILE, SeenStore::CURRENT_VERSION)
            .and_then(|()| Ok(serde_json::to_string_pretty(store)?))
            .and_then(|content| write_atomic(&self.path, &content));
        if let Err(e) = result {
            tracing::warn!("could not save {SEEN_STORE_FILE}: {e:#}");
        }
    }

    /// Apply one `agent.crash_reports.list` reply for `agent_id`. Returns
    /// `true` when the pending notices changed.
    pub fn observe(&self, agent_id: &str, reply: Result<Value, AgentCallError>) -> bool {
        let value = match reply {
            Ok(v) => v,
            // An old agent cannot share reports; a failure is retried on the
            // next connect. Neither touches what was seen.
            Err(AgentCallError::Unsupported) => return false,
            Err(AgentCallError::Failed(e)) => {
                tracing::debug!(agent_id, "agent crash-report check failed: {e}");
                return false;
            }
        };
        let names: Vec<String> = serde_json::from_value::<CrashReportsListResult>(value)
            .unwrap_or_default()
            .reports
            .into_iter()
            .map(|r| r.name)
            .filter(|n| crash_report::is_plain_report_name(n))
            .take(MAX_REMOTE_REPORTS)
            .collect();

        let mut inner = self.lock();
        let decision = decide(self.loaded(&mut inner).agents.get(agent_id), &names);
        match decision {
            Decision::Baseline { newest } => {
                self.loaded(&mut inner).agents.insert(
                    agent_id.to_string(),
                    SeenAgent {
                        newest_seen: newest,
                    },
                );
                self.save(&inner);
                inner.pending.remove(agent_id).is_some()
            }
            Decision::Notify { newest, new_count } => {
                let notice = AgentCrashNotice {
                    agent_id: agent_id.to_string(),
                    name: newest,
                    new_count,
                };
                inner.pending.insert(agent_id.to_string(), notice.clone()) != Some(notice)
            }
            Decision::NothingNew => inner.pending.remove(agent_id).is_some(),
        }
    }

    /// Pending notices, ordered by agent id.
    pub fn pending(&self) -> Vec<AgentCrashNotice> {
        self.lock().pending.values().cloned().collect()
    }

    /// Record `name` (and everything older) of `agent_id` as seen. Returns
    /// `true` when the pending notices changed.
    pub fn acknowledge(&self, agent_id: &str, name: &str) -> bool {
        if !crash_report::is_plain_report_name(name) {
            return false;
        }
        let mut inner = self.lock();
        let entry = self
            .loaded(&mut inner)
            .agents
            .entry(agent_id.to_string())
            .or_default();
        if entry.newest_seen.as_deref().is_none_or(|s| name > s) {
            entry.newest_seen = Some(name.to_string());
        }
        self.save(&inner);
        let covered = inner
            .pending
            .get(agent_id)
            .is_some_and(|p| p.name.as_str() <= name);
        if covered {
            inner.pending.remove(agent_id);
        }
        covered
    }
}

/// List `agent_id`'s crash reports once over `source` and fold the reply into
/// `service`. Returns `true` when the pending notices changed. Exactly one
/// call; [`ConnectedAgents`] refuses it (without network) for an agent that is
/// not connected, which is then just a failed, retried-next-time check.
pub fn check_agent(
    source: &dyn AgentReportSource,
    service: &AgentCrashNoticeService,
    agent_id: &str,
) -> bool {
    let reply = source.call(agent_id, AGENT_CRASH_REPORTS_LIST, json!({}));
    service.observe(agent_id, reply)
}

/// Whether the user still wants crash notices (`showCrashReportNotice`, which
/// defaults to shown).
fn notices_enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<Arc<crate::settings_projection::SettingsStore>>()
        .and_then(|s| {
            s.snapshot()
                .get(SHOW_NOTICE_SETTING)
                .and_then(Value::as_bool)
        })
        .unwrap_or(true)
}

/// Emit the current pending notices to every window.
pub fn emit_pending<R: Runtime>(app: &AppHandle<R>, service: &AgentCrashNoticeService) {
    let _ = app.emit(AGENT_CRASH_NOTICES_EVENT, service.pending());
}

/// Called when `agent_id` has just (re)connected: run the best-effort check on
/// a blocking worker so the connect path never waits for it. A no-op when the
/// service or agent manager is not managed (unit tests) or the user opted out.
pub fn spawn_check<R: Runtime>(app: &AppHandle<R>, agent_id: &str) {
    if app.try_state::<Arc<AgentCrashNoticeService>>().is_none() || !notices_enabled(app) {
        return;
    }
    let app = app.clone();
    let agent_id = agent_id.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let (Some(service), Some(client)) = (
            app.try_state::<Arc<AgentCrashNoticeService>>(),
            app.try_state::<Arc<dyn AgentRpcClient>>(),
        ) else {
            return;
        };
        let client: Arc<dyn AgentRpcClient> = (*client).clone();
        if check_agent(&ConnectedAgents(client.as_ref()), &service, &agent_id) {
            emit_pending(&app, &service);
        }
    });
}

#[cfg(test)]
#[path = "agent_crash_notice_tests.rs"]
mod tests;
