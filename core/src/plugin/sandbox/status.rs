//! What the UI shows about a native plugin's sandbox (plugin OS-sandbox phase
//! 6, #4188): the isolation the runner reported (or why the plugin was
//! refused), the runner's process state and the bridge requests it was
//! refused.
//!
//! The host records one [`SandboxOutcome`] per load attempt and
//! [`PluginHost::sandbox_status`](crate::plugin::PluginHost::sandbox_status)
//! combines it with the live [`SandboxedPluginHandle`] into a
//! [`PluginSandboxStatus`], the per-plugin row of the desktop's
//! `plugin-sandbox` projection region.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use termihub_plugin_runner::ipc::SandboxReport;
use termihub_plugin_runner::sandbox::Isolation;

use super::bridge::BridgeDenial;
use super::exit::RunnerExitCause;
use super::handle::SandboxedPluginHandle;
use crate::plugin::HostError;

/// How many recent bridge denials a status carries (newest last).
pub const STATUS_DENIALS: usize = 5;

/// The isolation a plugin runs with, as the Settings row labels it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum IsolationStatus {
    /// Every sandbox layer is enforced ("Isolated").
    Full,
    /// Some layers are missing and the user accepted that ("Reduced isolation
    /// (accepted)").
    Reduced,
    /// The runner enforces nothing: this platform's sandbox phase has not
    /// landed yet ("Not sandboxed").
    Unconfined,
    /// Some layers are missing and the user has not accepted that, so the
    /// plugin was not loaded ("Isolation unavailable on this system").
    Unavailable,
    /// Setting the sandbox up failed; the plugin was not loaded ("Could not
    /// start the plugin sandbox").
    Failed,
    /// The plugin runner could not be started ("Plugin runner is missing —
    /// reinstall termiHub").
    RunnerMissing,
}

/// What happened when the host last tried to load a plugin out of process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SandboxOutcome {
    /// Reduced isolation without the acknowledgement: not loaded.
    NeedsReducedAck {
        /// The layers the runner could not enforce.
        missing: Vec<String>,
    },
    /// The sandbox could not be set up: not loaded.
    SetupFailed(String),
    /// The runner could not be started: not loaded.
    RunnerMissing(String),
}

impl SandboxOutcome {
    /// The refusal a failed out-of-process load maps to, if it is one the
    /// Settings row explains (others surface through the plugin's error state).
    pub(crate) fn from_error(error: &HostError) -> Option<Self> {
        match error {
            HostError::ReducedIsolationNotAccepted { missing } => Some(Self::NeedsReducedAck {
                missing: missing.clone(),
            }),
            HostError::SandboxSetupFailed(detail) => Some(Self::SetupFailed(detail.clone())),
            HostError::RunnerUnavailable { detail, .. } => {
                Some(Self::RunnerMissing(detail.clone()))
            }
            _ => None,
        }
    }
}

/// The runner's process state ("Running · 2 sessions", "Idle", …).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProcessState {
    /// A runner is running.
    Running,
    /// No runner right now (reaped after idling, or not started yet).
    Idle,
    /// The runner crashed and is being restarted.
    Restarting,
    /// The crash budget is spent; the plugin is off until re-enabled.
    Disabled,
}

/// Why a runner ended, with the line the UI shows for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginExitInfo {
    /// The classified cause (`kind`: crashed, notResponding, outOfMemory,
    /// invalidData, stopped).
    #[serde(flatten)]
    pub cause: RunnerExitCause,
    /// [`RunnerExitCause::describe`], for the crash overlay's detail box.
    pub message: String,
}

impl From<&RunnerExitCause> for PluginExitInfo {
    fn from(cause: &RunnerExitCause) -> Self {
        Self {
            cause: cause.clone(),
            message: cause.describe(),
        }
    }
}

/// A runner's process status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessStatus {
    /// Running, idle, restarting or disabled.
    pub state: ProcessState,
    /// Open sessions in the running runner.
    pub sessions: usize,
    /// Crashes counted in the current window ("Restarting (n/3)").
    pub crashes: u32,
    /// Crashes restarted before the plugin is auto-disabled.
    pub max_restarts: u32,
    /// How the last runner ended, if one did.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_exit: Option<PluginExitInfo>,
    /// Why the plugin was auto-disabled ("Disabled after 3 crashes").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_disabled: Option<String>,
}

/// One refused bridge request, for the denial toast.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DenialInfo {
    /// The bridge call (`open_connection`, `read_file`, …).
    pub operation: String,
    /// What was asked for (`host:port` or a path), sanitised.
    pub target: String,
    /// Why, as the camelCase name of the host's [`DenialReason`](super::DenialReason)
    /// (`permission`, `resourceLimit`, …). A string, not a closed enum, so a
    /// reason the host adds later reaches the UI without a lock-step change.
    pub reason: String,
    /// When, in milliseconds since the Unix epoch.
    pub at_ms: u64,
    /// How many refused calls this entry stands for (a kernel-level
    /// `syscall` denial report folds repeats; 1 for a bridge denial).
    pub count: u32,
}

impl DenialInfo {
    /// Build the UI record for a refusal of `operation` on `target` at `at`.
    #[must_use]
    pub fn new(
        operation: &str,
        target: &str,
        reason: &impl std::fmt::Debug,
        at: SystemTime,
    ) -> Self {
        Self {
            operation: operation.to_owned(),
            target: target.to_owned(),
            reason: camel_case(&format!("{reason:?}")),
            at_ms: at
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX)),
            count: 1,
        }
    }
}

impl From<&BridgeDenial> for DenialInfo {
    fn from(denial: &BridgeDenial) -> Self {
        Self {
            count: denial.count.max(1),
            ..Self::new(denial.operation, &denial.target, &denial.reason, denial.at)
        }
    }
}

/// `ResourceLimit` → `resourceLimit` (a unit variant's `Debug` name).
fn camel_case(name: &str) -> String {
    let mut chars = name.chars();
    chars
        .next()
        .map(|first| first.to_lowercase().chain(chars).collect())
        .unwrap_or_default()
}

/// Everything the Settings row and the toasts show about one native plugin
/// run out of process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSandboxStatus {
    /// The isolation badge.
    pub isolation: IsolationStatus,
    /// The layers the runner enforces.
    pub enforced: Vec<String>,
    /// The layers this system cannot enforce (reduced / unavailable).
    pub missing: Vec<String>,
    /// Why the sandbox or the runner could not be started (failed /
    /// runnerMissing), for the log details.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// The runner's process status, while the plugin is loaded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process: Option<ProcessStatus>,
    /// The most recent refused bridge requests, oldest first.
    pub denials: Vec<DenialInfo>,
}

impl PluginSandboxStatus {
    /// The status of a plugin that was refused before it loaded.
    pub(crate) fn refused(outcome: &SandboxOutcome) -> Self {
        let (isolation, missing, detail) = match outcome {
            SandboxOutcome::NeedsReducedAck { missing } => {
                (IsolationStatus::Unavailable, missing.clone(), None)
            }
            SandboxOutcome::SetupFailed(detail) => {
                (IsolationStatus::Failed, Vec::new(), Some(detail.clone()))
            }
            SandboxOutcome::RunnerMissing(detail) => (
                IsolationStatus::RunnerMissing,
                Vec::new(),
                Some(detail.clone()),
            ),
        };
        Self {
            isolation,
            enforced: Vec::new(),
            missing,
            detail,
            process: None,
            denials: Vec::new(),
        }
    }

    /// The status of a plugin loaded out of process.
    pub(crate) fn loaded(handle: &SandboxedPluginHandle) -> Self {
        let report = handle.sandbox_report();
        let health = handle.health();
        let running = handle.running();
        let state = if health.auto_disabled.is_some() {
            ProcessState::Disabled
        } else if running.is_some() {
            ProcessState::Running
        } else if health
            .last_exit
            .as_ref()
            .is_some_and(RunnerExitCause::is_failure)
        {
            ProcessState::Restarting
        } else {
            ProcessState::Idle
        };
        let denials = running
            .as_ref()
            .map(|plugin| {
                let all = plugin.bridge_denials();
                let skip = all.len().saturating_sub(STATUS_DENIALS);
                all.iter().skip(skip).map(DenialInfo::from).collect()
            })
            .unwrap_or_default();
        Self {
            isolation: isolation_of(&report),
            enforced: report.enforced.clone(),
            missing: report.missing.clone(),
            detail: report.failed.clone(),
            process: Some(ProcessStatus {
                state,
                sessions: running.as_ref().map_or(0, |p| p.session_count()),
                crashes: health.crashes,
                max_restarts: health.max_restarts,
                last_exit: health.last_exit.as_ref().map(PluginExitInfo::from),
                auto_disabled: health.auto_disabled,
            }),
            denials,
        }
    }
}

/// The badge for a runner that loaded the plugin (a refused report never
/// gets here).
fn isolation_of(report: &SandboxReport) -> IsolationStatus {
    match report.isolation() {
        Isolation::Full => IsolationStatus::Full,
        Isolation::Reduced => IsolationStatus::Reduced,
        Isolation::Unconfined => IsolationStatus::Unconfined,
        Isolation::Failed => IsolationStatus::Failed,
    }
}

#[cfg(test)]
mod tests {
    use super::super::bridge::DenialReason;
    use super::*;
    use std::time::Duration;

    #[test]
    fn a_refusal_maps_to_its_badge() {
        let reduced = SandboxOutcome::from_error(&HostError::ReducedIsolationNotAccepted {
            missing: vec!["landlock".into()],
        })
        .unwrap();
        let status = PluginSandboxStatus::refused(&reduced);
        assert_eq!(status.isolation, IsolationStatus::Unavailable);
        assert_eq!(status.missing, vec!["landlock".to_owned()]);
        assert!(status.process.is_none());

        let failed =
            SandboxOutcome::from_error(&HostError::SandboxSetupFailed("boom".into())).unwrap();
        let status = PluginSandboxStatus::refused(&failed);
        assert_eq!(status.isolation, IsolationStatus::Failed);
        assert_eq!(status.detail.as_deref(), Some("boom"));

        let missing = SandboxOutcome::from_error(&HostError::RunnerUnavailable {
            path: "/x/runner".into(),
            detail: "not found".into(),
        })
        .unwrap();
        assert_eq!(
            PluginSandboxStatus::refused(&missing).isolation,
            IsolationStatus::RunnerMissing
        );

        // Other load errors are explained by the plugin's own error state.
        assert!(SandboxOutcome::from_error(&HostError::RunnerProtocol("x".into())).is_none());
    }

    #[test]
    fn the_report_classifies_the_badge() {
        assert_eq!(
            isolation_of(&SandboxReport::enforced(&["seatbelt"])),
            IsolationStatus::Full
        );
        assert_eq!(
            isolation_of(&SandboxReport::default()),
            IsolationStatus::Unconfined
        );
        let reduced = SandboxReport {
            missing: vec!["landlock".into()],
            ..SandboxReport::enforced(&["seccomp"])
        };
        assert_eq!(isolation_of(&reduced), IsolationStatus::Reduced);
    }

    #[test]
    fn statuses_serialise_in_camel_case() {
        let status = PluginSandboxStatus {
            isolation: IsolationStatus::RunnerMissing,
            enforced: Vec::new(),
            missing: Vec::new(),
            detail: None,
            process: Some(ProcessStatus {
                state: ProcessState::Restarting,
                sessions: 0,
                crashes: 1,
                max_restarts: 3,
                last_exit: Some(PluginExitInfo::from(&RunnerExitCause::OutOfMemory)),
                auto_disabled: None,
            }),
            denials: vec![DenialInfo::new(
                "open_connection",
                "10.0.0.12:502",
                &DenialReason::Permission,
                SystemTime::UNIX_EPOCH + Duration::from_millis(1500),
            )],
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["isolation"], "runnerMissing");
        assert_eq!(json["process"]["state"], "restarting");
        assert_eq!(json["process"]["maxRestarts"], 3);
        assert_eq!(json["process"]["lastExit"]["kind"], "outOfMemory");
        assert_eq!(
            json["process"]["lastExit"]["message"],
            "the plugin used too much memory"
        );
        assert_eq!(json["denials"][0]["operation"], "open_connection");
        assert_eq!(json["denials"][0]["reason"], "permission");
        assert_eq!(json["denials"][0]["count"], 1);
        assert_eq!(
            DenialInfo::new(
                "connect",
                "",
                &DenialReason::Syscall,
                SystemTime::UNIX_EPOCH
            )
            .reason,
            "syscall"
        );
        assert_eq!(
            DenialInfo::new(
                "x",
                "",
                &DenialReason::ResourceLimit,
                SystemTime::UNIX_EPOCH
            )
            .reason,
            "resourceLimit"
        );
        assert_eq!(json["denials"][0]["atMs"], 1500);
        assert!(json.get("detail").is_none());
    }
}
