//! Remote agent log files in the diagnostics export (#4519).
//!
//! Every agent process writes its own log file on its host
//! (`<agent config>/logs/termihub-agent-<role>-<pid>.log`, plus capped
//! `termihub-agent-stderr-….log` captures, #4319). The desktop's "Export
//! diagnostics" dialog can pull those files from agents that are **already
//! connected** — over the existing agent connection, via `agent.logs.list` /
//! `.read` — and add them to the bundle under `agents/<agent>/logs/`. Nothing
//! here opens a new connection or talks to any other host.
//!
//! Mirrors the crash-report path ([`super::agent_crash_reports`], #3574), and
//! treats an agent's reply as untrusted input the same way:
//!
//! - Log names must pass [`remote_log::is_plain_log_name`] for the agent log
//!   family before they are used as zip entry names; agent ids are sanitized
//!   into a single path segment.
//! - Every text is cut to [`MAX_REMOTE_LOG_BYTES`] (keeping its newest lines,
//!   even if the agent ignored the cap) and the whole export to
//!   [`MAX_TOTAL_AGENT_LOG_BYTES`].
//! - The agent redacted the text; it lands in the bundle as a
//!   [`BundleSource::Text`] entry, which
//!   [`write_bundle`](super::diagnostics_bundle::write_bundle) redacts again
//!   with the desktop's redactor.
//!
//! An agent that predates the methods answers JSON-RPC "method not found"; it
//! is reported as `supported: false` and skipped, never treated as an error.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::json;
use termihub_core::diagnostics::file_log::AGENT_LOG_FAMILY;
use termihub_core::diagnostics::remote_log::{
    self, cap_tail, MAX_REMOTE_LOGS, MAX_REMOTE_LOG_BYTES, TAIL_CUT_MARKER,
};
use termihub_core::protocol::methods::{
    LogFileSummary, LogsListResult, LogsReadParams, LogsReadResult, AGENT_LOGS_LIST,
    AGENT_LOGS_READ,
};

use super::agent_crash_reports::{
    agent_folder, sanitize_segment, AgentCallError, AgentReportSource, AGENTS_DIR,
};
use super::diagnostics_bundle::{BundleEntry, BundleEntryInfo, BundleSource};

/// Cap on all remote agent log text in one export (4 MiB).
pub const MAX_TOTAL_AGENT_LOG_BYTES: u64 = 4 * 1024 * 1024;

/// Zip sub-folder of `agents/<agent>/` the log files are written under.
pub const LOGS_DIR: &str = "logs";

/// One connected agent's log files, for the export preview.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct AgentLogs {
    /// The agent's id (the frontend maps it to the agent's display name).
    pub agent_id: String,
    /// `false` when the agent is too old to share its log files.
    pub supported: bool,
    /// The agent's log files, newest first (validated names only).
    #[cfg_attr(
        test,
        ts(type = "Array<import(\"./AgentLogFileSummary\").AgentLogFileSummary>")
    )]
    pub logs: Vec<LogFileSummary>,
    /// Why the listing failed, when it did (the agent is then skipped).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub error: Option<String>,
}

/// One remote log file the user chose to include.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct AgentLogRef {
    pub agent_id: String,
    pub name: String,
}

fn is_agent_log_name(name: &str) -> bool {
    remote_log::is_plain_log_name(name, AGENT_LOG_FAMILY)
}

/// List the log files of every connected agent. Never contacts an agent that
/// is not connected; a failing agent is reported, not fatal.
pub fn list_connected_agent_logs(source: &dyn AgentReportSource) -> Vec<AgentLogs> {
    source
        .connected_agents()
        .into_iter()
        .map(
            |agent_id| match source.call(&agent_id, AGENT_LOGS_LIST, json!({})) {
                Ok(value) => {
                    let parsed: LogsListResult = serde_json::from_value(value).unwrap_or_default();
                    let logs = parsed
                        .logs
                        .into_iter()
                        .filter(|l| is_agent_log_name(&l.name))
                        .take(MAX_REMOTE_LOGS)
                        .collect();
                    AgentLogs {
                        agent_id,
                        supported: true,
                        logs,
                        error: None,
                    }
                }
                Err(AgentCallError::Unsupported) => AgentLogs {
                    agent_id,
                    supported: false,
                    logs: Vec::new(),
                    error: None,
                },
                Err(AgentCallError::Failed(e)) => AgentLogs {
                    agent_id,
                    supported: true,
                    logs: Vec::new(),
                    error: Some(e),
                },
            },
        )
        .collect()
}

/// Fetch one selected log's text: validated, connected agent only, capped.
fn fetch_one(
    source: &dyn AgentReportSource,
    connected: &HashSet<String>,
    pick: &AgentLogRef,
) -> Result<String, String> {
    if !is_agent_log_name(&pick.name) {
        return Err("not an agent log file name".into());
    }
    if !connected.contains(&pick.agent_id) {
        return Err("agent is not connected".into());
    }
    let params = serde_json::to_value(LogsReadParams {
        name: pick.name.clone(),
    })
    .map_err(|e| e.to_string())?;
    let reply = source
        .call(&pick.agent_id, AGENT_LOGS_READ, params)
        .map_err(|e| match e {
            AgentCallError::Unsupported => "agent version cannot share its log files".to_string(),
            AgentCallError::Failed(m) => m,
        })?;
    let read: LogsReadResult =
        serde_json::from_value(reply).map_err(|_| "malformed reply".to_string())?;
    let body = read
        .text
        .strip_prefix(TAIL_CUT_MARKER)
        .map(str::to_string)
        .unwrap_or(read.text);
    let (text, cut) = cap_tail(body, MAX_REMOTE_LOG_BYTES);
    Ok(if cut || read.truncated {
        format!("{TAIL_CUT_MARKER}{text}")
    } else {
        text
    })
}

/// Fetch the selected remote log files and turn them into bundle entries
/// under `agents/<agent>/logs/`.
///
/// Skips (with a note in `agents/skipped-logs.txt`) any selection whose agent
/// is not connected, whose name is not a plain agent log name, whose read
/// fails, or that would exceed [`MAX_TOTAL_AGENT_LOG_BYTES`]. Duplicates are
/// fetched once.
pub fn fetch_agent_log_entries(
    source: &dyn AgentReportSource,
    selection: &[AgentLogRef],
) -> Vec<BundleEntry> {
    let connected: HashSet<String> = source.connected_agents().into_iter().collect();
    let mut seen = HashSet::new();
    let mut entries = Vec::new();
    let mut skipped = Vec::new();
    let mut total: u64 = 0;

    for pick in selection {
        if !seen.insert(pick) {
            continue;
        }
        let folder = agent_folder(&pick.agent_id);
        let label = format!("{folder}/{LOGS_DIR}/{}", sanitize_segment(&pick.name));
        let text = match fetch_one(source, &connected, pick) {
            Ok(t) => t,
            Err(e) => {
                skipped.push(format!("{label}: {e}"));
                continue;
            }
        };
        let size = text.len() as u64;
        if total.saturating_add(size) > MAX_TOTAL_AGENT_LOG_BYTES {
            skipped.push(format!("{label}: total size limit for agent logs reached"));
            continue;
        }
        total += size;
        entries.push(BundleEntry {
            info: BundleEntryInfo {
                name: format!("{folder}/{LOGS_DIR}/{}", pick.name),
                size,
                description: "Remote agent log".to_string(),
            },
            source: BundleSource::Text(text),
        });
    }

    if !skipped.is_empty() {
        let mut note =
            String::from("Remote agent log files that were selected but not included:\n\n");
        for line in &skipped {
            note.push_str("  ");
            note.push_str(line);
            note.push('\n');
        }
        entries.push(BundleEntry {
            info: BundleEntryInfo {
                name: format!("{AGENTS_DIR}/skipped-logs.txt"),
                size: note.len() as u64,
                description: "Agent log files that could not be included".to_string(),
            },
            source: BundleSource::Text(note),
        });
    }
    entries
}

#[cfg(test)]
#[path = "agent_logs_tests.rs"]
mod tests;
