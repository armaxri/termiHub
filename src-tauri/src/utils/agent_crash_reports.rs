//! Remote agent crash reports in the diagnostics export (#3574, OBS-010).
//!
//! A remote agent writes its own redacted crash reports on its host
//! (`agent::panic_hook`). The desktop's "Export diagnostics" dialog can pull
//! those reports from agents that are **already connected** — over the existing
//! agent connection, via `agent.crash_reports.list` / `.read` — and add them to
//! the bundle. Nothing here opens a new connection or talks to any other host.
//!
//! Trust boundary: an agent's reply is treated as untrusted input.
//!
//! - Report names must pass [`crash_report::is_plain_report_name`] before they
//!   are used as zip entry names, and agent ids are sanitized into a single
//!   path segment.
//! - Every text is cut to [`crash_report::MAX_REMOTE_REPORT_BYTES`] (even if the
//!   agent ignored the cap) and the whole export to [`MAX_TOTAL_AGENT_REPORT_BYTES`].
//! - The text lands in the bundle as a [`BundleSource::Text`] entry, which
//!   [`write_bundle`](super::diagnostics_bundle::write_bundle) redacts again with
//!   the desktop's redactor — the agent redacted it once already, this is the
//!   second, local pass.
//!
//! An agent that predates the methods answers JSON-RPC "method not found"; it is
//! reported as `supported: false` and skipped, never treated as an error.

use std::collections::HashSet;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use termihub_core::diagnostics::crash_report::{self, MAX_REMOTE_REPORTS, MAX_REMOTE_REPORT_BYTES};
use termihub_core::diagnostics::redact::Redactor;
use termihub_core::protocol::methods::{
    CrashReportSummary, CrashReportsListResult, CrashReportsReadParams, CrashReportsReadResult,
    AGENT_CRASH_REPORTS_LIST, AGENT_CRASH_REPORTS_READ,
};

use super::diagnostics_bundle::{BundleEntry, BundleEntryInfo, BundleSource};
use crate::terminal::agent_manager::AgentRpcClient;
use crate::utils::errors::TerminalError;

/// Cap on all remote agent crash-report text in one export (1 MiB).
pub const MAX_TOTAL_AGENT_REPORT_BYTES: u64 = 1024 * 1024;

/// Zip folder remote agent reports are written under.
pub const AGENTS_DIR: &str = "agents";

/// Why a call to an agent failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentCallError {
    /// The agent predates the method ("method not found").
    Unsupported,
    /// Anything else (timeout, lost connection, agent-side error).
    Failed(String),
}

/// The narrow view of the agent connection manager this module needs, so it
/// can be tested without a live agent.
pub trait AgentReportSource {
    /// Ids of the agents that are connected right now.
    fn connected_agents(&self) -> Vec<String>;
    /// Send one JSON-RPC request to a connected agent.
    fn call(&self, agent_id: &str, method: &str, params: Value) -> Result<Value, AgentCallError>;
}

/// Wait bound for one crash-report call to a connected agent (#3574, #3593):
/// the export and the post-connect notice check are best-effort and must not
/// stall on an unresponsive agent.
pub const AGENT_REPORT_TIMEOUT: Duration = Duration::from_secs(10);

/// Adapts the agent connection manager to the narrow [`AgentReportSource`]
/// the remote crash-report export and the post-connect notice use.
pub struct ConnectedAgents<'a>(pub &'a dyn AgentRpcClient);

impl AgentReportSource for ConnectedAgents<'_> {
    fn connected_agents(&self) -> Vec<String> {
        self.0.connected_agent_ids()
    }

    fn call(&self, agent_id: &str, method: &str, params: Value) -> Result<Value, AgentCallError> {
        // Re-check right before the call: never contact an agent that is not
        // (still) connected.
        if !self.0.is_connected(agent_id) {
            return Err(AgentCallError::Failed("agent is not connected".into()));
        }
        self.0
            .send_request_bounded(agent_id, method, params, AGENT_REPORT_TIMEOUT)
            .map_err(agent_call_error)
    }
}

/// An older agent's "method not found" (typed as
/// [`TerminalError::AgentUnsupported`], classified by code) means "skip this
/// agent"; everything else is a per-agent failure.
pub fn agent_call_error(e: TerminalError) -> AgentCallError {
    match e {
        TerminalError::AgentUnsupported(_) => AgentCallError::Unsupported,
        other => AgentCallError::Failed(other.to_string()),
    }
}

/// One connected agent's crash reports, for the export preview.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCrashReports {
    /// The agent's id (the frontend maps it to the agent's display name).
    pub agent_id: String,
    /// `false` when the agent is too old to share crash reports.
    pub supported: bool,
    /// The agent's crash reports, newest first (validated names only).
    pub reports: Vec<CrashReportSummary>,
    /// Why the listing failed, when it did (the agent is then skipped).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// One remote report the user chose to include.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCrashReportRef {
    pub agent_id: String,
    pub name: String,
}

/// List the crash reports of every connected agent. Never contacts an agent
/// that is not connected; a failing agent is reported, not fatal.
pub fn list_connected_agent_reports(source: &dyn AgentReportSource) -> Vec<AgentCrashReports> {
    source
        .connected_agents()
        .into_iter()
        .map(|agent_id| {
            let reply = source.call(&agent_id, AGENT_CRASH_REPORTS_LIST, json!({}));
            match reply {
                Ok(value) => {
                    let parsed: CrashReportsListResult =
                        serde_json::from_value(value).unwrap_or_default();
                    let reports = parsed
                        .reports
                        .into_iter()
                        .filter(|r| crash_report::is_plain_report_name(&r.name))
                        .take(MAX_REMOTE_REPORTS)
                        .collect();
                    AgentCrashReports {
                        agent_id,
                        supported: true,
                        reports,
                        error: None,
                    }
                }
                Err(AgentCallError::Unsupported) => AgentCrashReports {
                    agent_id,
                    supported: false,
                    reports: Vec::new(),
                    error: None,
                },
                Err(AgentCallError::Failed(e)) => AgentCrashReports {
                    agent_id,
                    supported: true,
                    reports: Vec::new(),
                    error: Some(e),
                },
            }
        })
        .collect()
}

/// Fetch the selected remote reports and turn them into bundle entries.
///
/// Skips (with a note in `agents/skipped.txt`) any selection whose agent is not
/// connected, whose name is not a plain report name, whose read fails, or that
/// would exceed [`MAX_TOTAL_AGENT_REPORT_BYTES`]. Duplicates are fetched once.
pub fn fetch_agent_report_entries(
    source: &dyn AgentReportSource,
    selection: &[AgentCrashReportRef],
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
        let label = format!("{folder}/{}", sanitize_segment(&pick.name));
        if !crash_report::is_plain_report_name(&pick.name) {
            skipped.push(format!("{label}: not a crash report name"));
            continue;
        }
        if !connected.contains(&pick.agent_id) {
            skipped.push(format!("{label}: agent is not connected"));
            continue;
        }
        let params = match serde_json::to_value(CrashReportsReadParams {
            name: pick.name.clone(),
        }) {
            Ok(p) => p,
            Err(e) => {
                skipped.push(format!("{label}: {e}"));
                continue;
            }
        };
        let reply = match source.call(&pick.agent_id, AGENT_CRASH_REPORTS_READ, params) {
            Ok(v) => v,
            Err(AgentCallError::Unsupported) => {
                skipped.push(format!("{label}: agent version cannot share crash reports"));
                continue;
            }
            Err(AgentCallError::Failed(e)) => {
                skipped.push(format!("{label}: {e}"));
                continue;
            }
        };
        let Ok(read) = serde_json::from_value::<CrashReportsReadResult>(reply) else {
            skipped.push(format!("{label}: malformed reply"));
            continue;
        };
        let (mut text, cut) = cap_text(read.text, MAX_REMOTE_REPORT_BYTES);
        if cut || read.truncated {
            text.push_str("\n… [truncated by the size cap]\n");
        }
        let size = text.len() as u64;
        if total.saturating_add(size) > MAX_TOTAL_AGENT_REPORT_BYTES {
            skipped.push(format!(
                "{label}: total size limit for agent reports reached"
            ));
            continue;
        }
        total += size;
        entries.push(BundleEntry {
            info: BundleEntryInfo {
                name: format!("{folder}/{}/{}", crash_report::CRASH_DIR_NAME, pick.name),
                size,
                description: "Remote agent crash report".to_string(),
            },
            source: BundleSource::Text(text),
        });
    }

    if !skipped.is_empty() {
        let mut note =
            String::from("Remote agent crash reports that were selected but not included:\n\n");
        for line in &skipped {
            note.push_str("  ");
            note.push_str(line);
            note.push('\n');
        }
        entries.push(BundleEntry {
            info: BundleEntryInfo {
                name: format!("{AGENTS_DIR}/skipped.txt"),
                size: note.len() as u64,
                description: "Agent crash reports that could not be included".to_string(),
            },
            source: BundleSource::Text(note),
        });
    }
    entries
}

/// Read one remote report for the in-app viewer (#3593): validated name,
/// connected agent only, capped to [`MAX_REMOTE_REPORT_BYTES`], and redacted
/// again with the desktop's `redactor` (the agent redacted it once already).
pub fn read_agent_report_text(
    source: &dyn AgentReportSource,
    agent_id: &str,
    name: &str,
    redactor: &Redactor,
) -> Result<String, String> {
    if !crash_report::is_plain_report_name(name) {
        return Err("not a crash report name".into());
    }
    let params = serde_json::to_value(CrashReportsReadParams {
        name: name.to_string(),
    })
    .map_err(|e| e.to_string())?;
    let reply = source
        .call(agent_id, AGENT_CRASH_REPORTS_READ, params)
        .map_err(|e| match e {
            AgentCallError::Unsupported => {
                "this agent version cannot share crash reports".to_string()
            }
            AgentCallError::Failed(m) => m,
        })?;
    let read: CrashReportsReadResult =
        serde_json::from_value(reply).map_err(|_| "malformed reply from the agent".to_string())?;
    let (mut text, cut) = cap_text(read.text, MAX_REMOTE_REPORT_BYTES);
    if cut || read.truncated {
        text.push_str("\n… [truncated by the size cap]\n");
    }
    Ok(redactor.redact(&text))
}

/// `agents/<sanitized agent id>` — one safe path segment per agent.
pub fn agent_folder(agent_id: &str) -> String {
    format!("{AGENTS_DIR}/{}", sanitize_segment(agent_id))
}

/// Reduce an untrusted string to one short zip path segment.
fn sanitize_segment(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    if cleaned.is_empty() {
        "agent".to_string()
    } else {
        cleaned
    }
}

/// Cut `text` to at most `max` bytes on a char boundary.
fn cap_text(mut text: String, max: u64) -> (String, bool) {
    let max = usize::try_from(max).unwrap_or(usize::MAX);
    if text.len() <= max {
        return (text, false);
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    (text, true)
}

#[cfg(test)]
#[path = "agent_crash_reports_tests.rs"]
mod tests;
