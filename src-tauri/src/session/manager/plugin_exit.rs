//! Plugin-process exits (#4188, plugin OS-sandbox phase 6): when a plugin
//! session served out of process ends because its plugin runner crashed,
//! stopped responding, ran out of memory or sent invalid data, the tab's
//! `session-lifecycle` entry records why, so the terminal shows the crash
//! overlay ("The plugin stopped unexpectedly") with the cause and a *Restart
//! session* action instead of a generic "connection lost".
//!
//! The runner's exit cause is classified on the runner's reader thread, which
//! can finish a moment after the session's output already ended (a host kill
//! ends the output first). [`await_plugin_exit`] therefore waits, bounded by
//! [`PLUGIN_EXIT_WAIT`], while the runner is dead and its cause still pending —
//! and not at all for any other session.

use std::sync::Arc;
use std::time::{Duration, Instant};

use termihub_core::connection::{parse_plugin_type_id, ConnectionType};
use termihub_core::plugin::sandbox::RunnerExitCause;
use tokio::sync::Mutex;

use super::SessionMap;
use crate::session_projection::store::PluginSessionExit;

/// Longest wait for a dead runner's exit cause (the runner reap is bounded by
/// 2 s plus a short stderr drain).
pub(super) const PLUGIN_EXIT_WAIT: Duration = Duration::from_secs(3);

/// How often the pending cause is re-checked.
const POLL: Duration = Duration::from_millis(20);

/// What a session's plugin runner says right now.
enum RunnerVerdict {
    /// Not an out-of-process plugin session, or its runner is still running
    /// (the session ended on its own): nothing to report.
    NotApplicable,
    /// The runner died; its cause is still being classified.
    Pending,
    /// The runner died with this cause.
    Ended(PluginSessionExit),
}

/// Inspect `connection` once.
fn verdict(connection: &dyn ConnectionType) -> RunnerVerdict {
    let Some(alive) = connection.plugin_runner_alive() else {
        return RunnerVerdict::NotApplicable;
    };
    match connection.plugin_exit_cause() {
        Some(cause) => match plugin_session_exit(connection, &cause) {
            Some(exit) => RunnerVerdict::Ended(exit),
            None => RunnerVerdict::NotApplicable,
        },
        None if alive => RunnerVerdict::NotApplicable,
        None => RunnerVerdict::Pending,
    }
}

/// The overlay record for a runner failure (`None` for a host-initiated stop).
fn plugin_session_exit(
    connection: &dyn ConnectionType,
    cause: &RunnerExitCause,
) -> Option<PluginSessionExit> {
    if !cause.is_failure() {
        return None;
    }
    let kind = serde_json::to_value(cause)
        .ok()
        .and_then(|v| v.get("kind").and_then(|k| k.as_str()).map(str::to_owned))?;
    let plugin_id = parse_plugin_type_id(connection.type_id())
        .map(|(id, _)| id.to_owned())
        .unwrap_or_default();
    Some(PluginSessionExit {
        plugin_id,
        plugin_name: connection.display_name().to_owned(),
        kind,
        message: cause.describe(),
    })
}

/// Why `session_id`'s plugin runner failed, if it is a plugin session served
/// out of process whose runner died (see the module docs).
pub(super) async fn await_plugin_exit<M: SessionMap>(
    session_id: &str,
    sessions: &Arc<Mutex<M>>,
) -> Option<PluginSessionExit> {
    let deadline = Instant::now() + PLUGIN_EXIT_WAIT;
    loop {
        let verdict = {
            let sessions = sessions.lock().await;
            verdict(sessions.get(session_id)?.connection.as_ref())
        };
        match verdict {
            RunnerVerdict::NotApplicable => return None,
            RunnerVerdict::Ended(exit) => return Some(exit),
            RunnerVerdict::Pending if Instant::now() >= deadline => return None,
            RunnerVerdict::Pending => tokio::time::sleep(POLL).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use termihub_core::connection::{Capabilities, OutputReceiver, SettingsSchema};
    use termihub_core::errors::SessionError;
    use termihub_core::files::FileBrowser;
    use termihub_core::monitoring::MonitoringProvider;

    /// A connection that reports a fixed runner state.
    struct FakePlugin {
        alive: Option<bool>,
        cause: Option<RunnerExitCause>,
    }

    #[async_trait::async_trait]
    impl ConnectionType for FakePlugin {
        fn type_id(&self) -> &str {
            "plugin:acme:modbus"
        }
        fn display_name(&self) -> &str {
            "Acme Modbus"
        }
        fn settings_schema(&self) -> SettingsSchema {
            SettingsSchema { groups: Vec::new() }
        }
        fn capabilities(&self) -> Capabilities {
            Capabilities {
                monitoring: false,
                file_browser: false,
                graphical: false,
                resize: true,
                persistent: false,
                terminal: true,
                tunneling: false,
            }
        }
        async fn connect(&mut self, _settings: serde_json::Value) -> Result<(), SessionError> {
            Ok(())
        }
        async fn disconnect(&mut self) -> Result<(), SessionError> {
            Ok(())
        }
        fn is_connected(&self) -> bool {
            false
        }
        fn write(&self, _data: &[u8]) -> Result<(), SessionError> {
            Ok(())
        }
        fn resize(&self, _cols: u16, _rows: u16) -> Result<(), SessionError> {
            Ok(())
        }
        fn subscribe_output(&self) -> OutputReceiver {
            tokio::sync::mpsc::channel(1).1
        }
        fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
            None
        }
        fn file_browser(&self) -> Option<&dyn FileBrowser> {
            None
        }
        fn plugin_exit_cause(&self) -> Option<RunnerExitCause> {
            self.cause.clone()
        }
        fn plugin_runner_alive(&self) -> Option<bool> {
            self.alive
        }
    }

    fn fake(alive: Option<bool>, cause: Option<RunnerExitCause>) -> FakePlugin {
        FakePlugin { alive, cause }
    }

    #[test]
    fn a_crashed_runner_yields_the_overlay_record() {
        let cause = RunnerExitCause::Crashed {
            signal: None,
            exit_code: Some(101),
        };
        let RunnerVerdict::Ended(exit) = verdict(&fake(Some(false), Some(cause))) else {
            panic!("expected an ended verdict");
        };
        assert_eq!(exit.plugin_id, "acme");
        assert_eq!(exit.plugin_name, "Acme Modbus");
        assert_eq!(exit.kind, "crashed");
        assert_eq!(exit.message, "plugin process exited with code 101");
    }

    #[test]
    fn every_failure_kind_maps_to_its_overlay_kind() {
        for (cause, kind) in [
            (RunnerExitCause::NotResponding, "notResponding"),
            (RunnerExitCause::OutOfMemory, "outOfMemory"),
            (
                RunnerExitCause::InvalidData {
                    detail: "bad frame".into(),
                },
                "invalidData",
            ),
        ] {
            let RunnerVerdict::Ended(exit) = verdict(&fake(Some(false), Some(cause))) else {
                panic!("expected an ended verdict for {kind}");
            };
            assert_eq!(exit.kind, kind);
        }
    }

    #[test]
    fn a_stop_a_live_runner_or_another_backend_reports_nothing() {
        assert!(matches!(
            verdict(&fake(Some(false), Some(RunnerExitCause::Stopped))),
            RunnerVerdict::NotApplicable
        ));
        assert!(matches!(
            verdict(&fake(Some(true), None)),
            RunnerVerdict::NotApplicable
        ));
        assert!(matches!(
            verdict(&fake(None, None)),
            RunnerVerdict::NotApplicable
        ));
        assert!(matches!(
            verdict(&fake(Some(false), None)),
            RunnerVerdict::Pending
        ));
    }
}
