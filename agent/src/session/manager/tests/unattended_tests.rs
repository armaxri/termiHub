//! An unattended create (#3877) reaches a daemon-backed session's launch as
//! the unattended mode, and never gets the keyboard-interactive prompt relay —
//! not even while a prompt-capable desktop is attached.

use super::*;
use crate::session::types::SessionBackend;

/// What one launch was handed.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Seen {
    unattended: bool,
    prompt_relay: bool,
}

/// Records each launch's mode, then returns a stub.
#[derive(Default)]
struct RecordingLauncher {
    seen: Arc<std::sync::Mutex<Vec<Seen>>>,
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
        self.seen.lock().unwrap().push(Seen {
            unattended: extras.unattended,
            prompt_relay: extras.ki_prompt.is_some(),
        });
        Ok(SessionBackend::Stub {
            alive: Arc::new(AtomicBool::new(true)),
        })
    }
}

/// The attached desktop's notification receiver; dropping it detaches it.
type DesktopRx =
    tokio::sync::mpsc::UnboundedReceiver<crate::protocol::messages::JsonRpcNotification>;

/// A manager whose hub has a prompt-capable desktop attached (kept attached
/// while the returned receiver lives).
fn manager() -> (SessionManager, Arc<std::sync::Mutex<Vec<Seen>>>, DesktopRx) {
    let hub = KiPromptHub::new();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    hub.attach_client(tx);
    let launcher = RecordingLauncher::default();
    let seen = launcher.seen.clone();
    let mgr =
        SessionManager::with_launcher(test_notification_tx(), test_registry(), Arc::new(launcher))
            .with_ki_prompt_hub(hub);
    (mgr, seen, rx)
}

fn ssh() -> serde_json::Value {
    serde_json::json!({"host": "bastion", "username": "alice", "authMethod": "password"})
}

#[tokio::test]
async fn an_unattended_create_launches_the_daemon_unattended_without_a_prompt_relay() {
    let (mgr, seen, _desktop) = manager();
    mgr.create_with_mode("ssh", "t".into(), ssh(), None, None, true)
        .await
        .unwrap();
    assert_eq!(
        *seen.lock().unwrap(),
        vec![Seen {
            unattended: true,
            prompt_relay: false,
        }]
    );
}

#[tokio::test]
async fn an_attended_create_keeps_the_prompt_relay() {
    let (mgr, seen, _desktop) = manager();
    mgr.create("ssh", "t".into(), ssh(), None).await.unwrap();
    assert_eq!(
        *seen.lock().unwrap(),
        vec![Seen {
            unattended: false,
            prompt_relay: true,
        }]
    );
}
