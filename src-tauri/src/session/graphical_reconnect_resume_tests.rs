//! An automatic reconnect of a saved VNC connection's session resumes the
//! side-channel transfers waiting for that connection (#4230) — driven
//! through the manager's reactivation hook against the fake backend, with the
//! hook wired the way boot wires it (into the wait list's trigger).

use super::*;

use crate::files::transfer::persist::{PersistedGraphicalTarget, PersistedTransferStatus};
use crate::files::transfer::relaunch_auto::{due, WaitTrigger};
use crate::files::transfer::relaunch_graphical::park_interrupted;
use crate::files::transfer::{TransferDirection, TransferPersistenceManager, TransferRegistry};
use crate::session::graphical_manager::ReactivatedHook;

const VNC: &str = "Lab/pi-desktop";

/// What the hook saw: the connections it was told about, and the transfers
/// each call resumed.
#[derive(Clone, Default)]
struct Resumed {
    calls: Arc<StdMutex<Vec<String>>>,
    transfers: Arc<StdMutex<Vec<String>>>,
}

impl Resumed {
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
    fn transfers(&self) -> Vec<String> {
        self.transfers.lock().unwrap().clone()
    }
}

/// A persistence manager holding one side-channel upload of [`VNC`] that a
/// quit cut off, parked at startup to wait for its VNC connection.
fn parked_upload(dir: &std::path::Path) -> Arc<TransferPersistenceManager> {
    let persist = Arc::new(TransferPersistenceManager::new_test(dir));
    persist.record_registration(
        "cut-off",
        "rd-old",
        TransferDirection::Upload,
        "big.bin",
        "/home/pi/Desktop/big.bin",
        Some("/local/big.bin".to_string()),
        0,
    );
    persist.record_graphical_target(
        "cut-off",
        PersistedGraphicalTarget {
            connection_id: VNC.to_string(),
            route: termihub_core::connection::FileSideChannelKind::Ssh,
            host: "lab-pi".to_string(),
            user: "pi".to_string(),
            agent_id: None,
        },
    );
    persist.note_progress(
        "cut-off",
        PersistedTransferStatus::Active,
        4096,
        8192,
        false,
        None,
    );
    assert_eq!(park_interrupted(&persist).len(), 1);
    persist
}

/// The hook boot installs, with the background resume replaced by taking the
/// due rows off the wait list (what `spawn_resume_waiting` resumes).
fn hook(persist: &Arc<TransferPersistenceManager>, resumed: &Resumed) -> ReactivatedHook {
    let (persist, resumed) = (persist.clone(), resumed.clone());
    let registry = TransferRegistry::new();
    Arc::new(move |connection_id: &str| {
        resumed
            .calls
            .lock()
            .unwrap()
            .push(connection_id.to_string());
        let trigger = WaitTrigger::GraphicalSessionActive(connection_id.to_string());
        let ids = due(persist.credential_waits(), &trigger, &registry);
        resumed.transfers.lock().unwrap().extend(ids);
    })
}

/// Drop the live stream and wait until the reconnected generation paints.
async fn reconnect(h: &Harness, dial: u32) {
    h.ctl.drop_stream();
    wait_until("re-dial", || h.ctl.dials() == dial).await;
    h.ctl.send_frame().await;
    wait_until("reconnected", || {
        last_state(&h.sink) == Some(GraphicalState::Active)
    })
    .await;
}

#[tokio::test(start_paused = true)]
async fn auto_reconnect_resumes_a_waiting_side_channel_transfer_once() {
    let dir = tempfile::TempDir::new().unwrap();
    let persist = parked_upload(dir.path());
    let resumed = Resumed::default();
    let h = open_with(
        serde_json::json!({}),
        Dial::Ok,
        vec![Dial::Ok, Dial::Ok],
        Some(hook(&persist, &resumed)),
    )
    .await;
    h.mgr.bind_saved_connection(&h.sid, VNC).await;
    // A fresh connect never runs the hook: `remote_desktop_connect` raises
    // that trigger itself.
    idle().await;
    assert!(resumed.calls().is_empty());

    reconnect(&h, 2).await;
    wait_until("hook", || resumed.calls().len() == 1).await;
    assert_eq!(resumed.calls(), [VNC]);
    assert_eq!(resumed.transfers(), ["cut-off"]);

    // A second reconnect (or a connect trigger racing the first) finds the
    // row already taken off the list: no duplicate resume.
    reconnect(&h, 3).await;
    wait_until("hook again", || resumed.calls().len() == 2).await;
    assert_eq!(resumed.transfers(), ["cut-off"]);
    h.mgr.disconnect(&h.sid, h.sink.clone()).await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn a_session_without_a_saved_connection_resumes_nothing() {
    let dir = tempfile::TempDir::new().unwrap();
    let persist = parked_upload(dir.path());
    let resumed = Resumed::default();
    let h = open_with(
        serde_json::json!({}),
        Dial::Ok,
        vec![Dial::Ok],
        Some(hook(&persist, &resumed)),
    )
    .await;

    reconnect(&h, 2).await;
    idle().await;
    assert!(resumed.calls().is_empty());
    assert!(persist.credential_waits().contains("cut-off"));
    h.mgr.disconnect(&h.sid, h.sink.clone()).await.unwrap();
}
