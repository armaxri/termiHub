//! Local crash reports and the diagnostics export (OBS-010).
//!
//! Everything here reads or writes local files only. The crash notice is
//! fetched by the frontend *after* startup (never awaited on the startup path),
//! and the diagnostics bundle is only written to a path the user chose in a
//! save dialog.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use serde::Serialize;
use tauri::State;
use termihub_core::diagnostics::crash_report;
use termihub_core::diagnostics::redact::Redactor;

use crate::terminal::agent_manager::AgentRpcClient;
use crate::utils::agent_crash_notice::{self, AgentCrashNotice, AgentCrashNoticeService};
use crate::utils::agent_crash_reports::{
    self, AgentCrashReportRef, AgentCrashReports, ConnectedAgents,
};
use crate::utils::diagnostics_bundle::{self, BuildInfo, BundleEntryInfo};
use crate::utils::file_log;

/// The newest crash report the user has not yet been told about.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReportNotice {
    /// Report file name (pass to [`read_crash_report`]).
    pub name: String,
    /// Absolute path, for "show in folder" / support.
    pub path: String,
    /// Number of crash reports currently on disk.
    pub total: usize,
}

/// Result of a diagnostics export.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsExportResult {
    /// Where the bundle was written.
    pub path: String,
    /// Number of files in the bundle.
    pub file_count: usize,
}

fn crash_dir() -> Option<PathBuf> {
    file_log::log_dir().map(|d| crash_report::crash_dir_in(&d))
}

/// The pending crash notice, if a crash happened since the last acknowledgement.
#[tauri::command]
pub fn get_crash_report_notice() -> Option<CrashReportNotice> {
    let dir = crash_dir()?;
    let pending = crash_report::pending_notice(&dir)?;
    Some(CrashReportNotice {
        name: pending.name,
        path: pending.path.display().to_string(),
        total: crash_report::list_reports(&dir).len(),
    })
}

/// Mark every current crash report as seen, so the notice does not repeat.
#[tauri::command]
pub fn acknowledge_crash_reports() -> Result<(), String> {
    match crash_dir() {
        Some(dir) => crash_report::acknowledge(&dir).map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// Read one crash report's (already redacted) text by file name.
#[tauri::command]
pub fn read_crash_report(name: String) -> Result<String, String> {
    let dir = crash_dir().ok_or("no crash-report directory on this platform")?;
    crash_report::read_report(&dir, &name).map_err(|e| e.to_string())
}

/// The files a diagnostics export would contain, for the preview list.
#[tauri::command]
pub fn preview_diagnostics_bundle() -> Vec<BundleEntryInfo> {
    let log_dir = file_log::log_dir();
    diagnostics_bundle::plan_bundle(log_dir.as_deref(), &BuildInfo::current(), SystemTime::now())
        .into_iter()
        .map(|e| e.info)
        .collect()
}

/// The crash reports of every **already connected** remote agent, for the
/// export preview (#3574). An agent too old to share them is listed with
/// `supported: false`; nothing connects to an agent that is not connected.
#[tauri::command]
pub async fn list_agent_crash_reports(
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<Vec<AgentCrashReports>, String> {
    let manager = agent_manager.inner().clone();
    tokio::task::spawn_blocking(move || {
        agent_crash_reports::list_connected_agent_reports(&ConnectedAgents(manager.as_ref()))
    })
    .await
    .map_err(|e| format!("listing agent crash reports failed: {e}"))
}

/// Pending "agent crashed since last connect" notices (#3593). Changes are
/// also pushed as the `agent-crash-notices-changed` event.
#[tauri::command]
pub fn get_agent_crash_notices(
    service: State<'_, Arc<AgentCrashNoticeService>>,
) -> Vec<AgentCrashNotice> {
    service.pending()
}

/// Mark `name` (and every older report) of `agent_id` as seen, so its notice
/// is not shown again (#3593).
#[tauri::command]
pub fn acknowledge_agent_crash_notice(
    agent_id: String,
    name: String,
    app: tauri::AppHandle,
    service: State<'_, Arc<AgentCrashNoticeService>>,
) {
    if service.acknowledge(&agent_id, &name) {
        agent_crash_notice::emit_pending(&app, &service);
    }
}

/// Read one crash report of an already-connected agent for the viewer
/// (#3593), over the existing connection, capped and redacted again locally.
#[tauri::command]
pub async fn read_agent_crash_report(
    agent_id: String,
    name: String,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<String, String> {
    let manager = agent_manager.inner().clone();
    tokio::task::spawn_blocking(move || {
        agent_crash_reports::read_agent_report_text(
            &ConnectedAgents(manager.as_ref()),
            &agent_id,
            &name,
            &Redactor::for_current_environment(),
        )
    })
    .await
    .map_err(|e| format!("reading the agent crash report failed: {e}"))?
}

/// Write the redacted diagnostics zip to the user-chosen `destination`.
///
/// `agent_reports` are the remote agent crash reports the user kept selected in
/// the preview (#3574); they are fetched from their (connected) agents over the
/// existing connection, capped, and redacted again locally before bundling.
#[tauri::command]
pub async fn export_diagnostics_bundle(
    destination: String,
    agent_reports: Option<Vec<AgentCrashReportRef>>,
    agent_manager: State<'_, Arc<dyn AgentRpcClient>>,
) -> Result<DiagnosticsExportResult, String> {
    let dest = validate_destination(&destination)?;
    let manager = agent_manager.inner().clone();
    let selection = agent_reports.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let log_dir = file_log::log_dir();
        let mut entries = diagnostics_bundle::plan_bundle(
            log_dir.as_deref(),
            &BuildInfo::current(),
            SystemTime::now(),
        );
        if !selection.is_empty() {
            entries.extend(agent_crash_reports::fetch_agent_report_entries(
                &ConnectedAgents(manager.as_ref()),
                &selection,
            ));
        }
        let redactor = Redactor::for_current_environment();
        let file_count = diagnostics_bundle::write_bundle(&dest, &entries, &redactor)
            .map_err(|e| format!("failed to write diagnostics bundle: {e}"))?;
        tracing::info!(file_count, "diagnostics bundle exported");
        Ok(DiagnosticsExportResult {
            path: dest.display().to_string(),
            file_count,
        })
    })
    .await
    .map_err(|e| format!("diagnostics export task failed: {e}"))?
}

/// Require an absolute `.zip` path whose parent directory exists.
fn validate_destination(destination: &str) -> Result<PathBuf, String> {
    let path = Path::new(destination.trim());
    if !path.is_absolute() {
        return Err("the export destination must be an absolute path".into());
    }
    let is_zip = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("zip"));
    if !is_zip {
        return Err("the export destination must be a .zip file".into());
    }
    if !path.parent().is_some_and(Path::is_dir) {
        return Err("the export destination's folder does not exist".into());
    }
    Ok(path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destination_must_be_an_absolute_zip_in_an_existing_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let ok = tmp.path().join("diag.zip");
        assert_eq!(validate_destination(ok.to_str().unwrap()).unwrap(), ok);
        assert!(validate_destination("diag.zip").is_err());
        assert!(validate_destination(tmp.path().join("diag.txt").to_str().unwrap()).is_err());
        assert!(
            validate_destination(tmp.path().join("nope").join("d.zip").to_str().unwrap()).is_err()
        );
    }

    #[test]
    fn preview_always_includes_readme_and_system_info() {
        let names: Vec<String> = preview_diagnostics_bundle()
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(&names[..2], ["README.txt", "system-info.txt"]);
        assert!(!names.iter().any(|n| n.contains("sessions")));
    }
}
