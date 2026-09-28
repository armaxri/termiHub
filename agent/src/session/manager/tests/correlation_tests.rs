//! The desktop's `correlation_id` reaches a daemon-backed session's launch
//! (#3782, OBS-004 follow-up), so the session daemon can log its loop under the
//! same `agent_session` span the worker's create path uses. The id is untrusted:
//! only a well-formed one is handed on.

use super::*;
use crate::session::types::SessionBackend;

/// Records the correlation id each launch was handed, then returns a stub.
#[derive(Default)]
struct RecordingLauncher {
    seen: Arc<std::sync::Mutex<Vec<Option<String>>>>,
}

#[async_trait::async_trait]
impl DaemonLauncher for RecordingLauncher {
    async fn launch(
        &self,
        _session_id: &str,
        _type_id: &str,
        _settings: &serde_json::Value,
        _notification_tx: NotificationSender,
        _buffer_size_bytes: usize,
        extras: LaunchExtras,
    ) -> Result<SessionBackend, anyhow::Error> {
        self.seen.lock().unwrap().push(extras.correlation_id);
        Ok(SessionBackend::Stub {
            alive: Arc::new(AtomicBool::new(true)),
        })
    }
}

fn manager() -> (SessionManager, Arc<std::sync::Mutex<Vec<Option<String>>>>) {
    let launcher = RecordingLauncher::default();
    let seen = launcher.seen.clone();
    let mgr =
        SessionManager::with_launcher(test_notification_tx(), test_registry(), Arc::new(launcher));
    (mgr, seen)
}

fn ssh() -> serde_json::Value {
    serde_json::json!({"host": "bastion", "username": "alice", "authMethod": "password"})
}

#[tokio::test]
async fn a_valid_correlation_id_is_handed_to_the_daemon_launch() {
    let (mgr, seen) = manager();
    mgr.create_correlated("ssh", "t".into(), ssh(), None, Some("desk-sid-1"))
        .await
        .unwrap();
    assert_eq!(*seen.lock().unwrap(), vec![Some("desk-sid-1".to_string())]);
}

#[tokio::test]
async fn a_create_without_a_correlation_id_launches_without_one() {
    let (mgr, seen) = manager();
    mgr.create("ssh", "t".into(), ssh(), None).await.unwrap();
    assert_eq!(*seen.lock().unwrap(), vec![None]);
}

#[tokio::test]
async fn a_malformed_correlation_id_is_not_handed_to_the_daemon() {
    let (mgr, seen) = manager();
    mgr.create_correlated("ssh", "t".into(), ssh(), None, Some("evil\nforged line"))
        .await
        .unwrap();
    assert_eq!(*seen.lock().unwrap(), vec![None]);
}

#[test]
fn export_correlation_id_sets_the_daemon_env_var() {
    let mut command = std::process::Command::new("termihub-agent");
    export_correlation_id(&mut command, Some("desk-sid-1"));
    assert!(command.get_envs().any(|(k, v)| {
        k == crate::daemon::process::CORRELATION_ID_ENV && v == Some("desk-sid-1".as_ref())
    }));
}

#[test]
fn export_correlation_id_clears_an_inherited_value_when_absent() {
    // A stale id inherited from the worker's own environment must never
    // mislabel an uncorrelated session: absent means explicitly removed.
    let mut command = std::process::Command::new("termihub-agent");
    export_correlation_id(&mut command, None);
    assert!(command
        .get_envs()
        .any(|(k, v)| k == crate::daemon::process::CORRELATION_ID_ENV && v.is_none()));
}
