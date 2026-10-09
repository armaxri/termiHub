//! A session the backend reconnect redrive re-creates keeps the identity a
//! user-initiated connect gives it (#4301): its saved-connection binding, the
//! transfer-resume trigger for that connection, and the field secrets the
//! connect restored into its settings (#4289).
//!
//! Drives the **production** `AppReconnectRedrive`, `ReconnectTimerDriver` and
//! `SessionManager` against a fake direct connection type that records the
//! settings it is connected with, with a deterministic manual scheduler and the
//! session-opened hook wired into a real transfer wait list, the way boot wires
//! it into `spawn_resume_waiting`.

use std::sync::{Arc, Mutex};

use serde_json::Value;
use tauri::Manager;
use termihub_core::connection::{
    Capabilities, ConnectionType, ConnectionTypeRegistry, OutputReceiver, SettingsSchema,
};
use termihub_core::errors::SessionError;
use termihub_core::files::FileBrowser;
use termihub_core::monitoring::MonitoringProvider;

use crate::commands::projection::ProjectionState;
use crate::files::transfer::persist::{PersistedTransfer, PersistedTransferStatus};
use crate::files::transfer::relaunch_auto::{due, note_blocked, CredentialWaits, WaitTrigger};
use crate::files::transfer::relaunch_credentials::RelaunchBlocked;
use crate::files::transfer::{TransferDirection, TransferRegistry};
use crate::network::test_support::FakeAgent;
use crate::session::manager::{SessionManager, SessionOrigin};
use crate::session_projection::projection::{publish_sessions, SESSION_LIFECYCLE_REGION};
use crate::session_projection::redrive::AppReconnectRedrive;
use crate::session_projection::store::{SessionLifecycleStore, SessionStatus};
use crate::session_projection::timer::{
    ReconnectRedrive, ReconnectScheduler, ReconnectTimerDriver,
};

const SAVED: &str = "Work/build-box";
const FIELD_SECRET: &str = "gateway-secret";

/// The armed one-shots a [`ManualScheduler`] records.
type ArmedTasks = std::collections::HashMap<String, Box<dyn FnOnce() + Send>>;

/// A test scheduler that records armed one-shots and fires on command.
#[derive(Default)]
struct ManualScheduler {
    tasks: Mutex<ArmedTasks>,
}
impl ManualScheduler {
    fn fire(&self, key: &str) {
        let task = self.tasks.lock().unwrap().remove(key);
        if let Some(task) = task {
            task();
        }
    }
}
impl ReconnectScheduler for ManualScheduler {
    fn schedule(&self, key: String, _delay_ms: u64, task: Box<dyn FnOnce() + Send>) {
        self.tasks.lock().unwrap().insert(key, task);
    }
    fn cancel(&self, key: &str) {
        self.tasks.lock().unwrap().remove(key);
    }
}

/// A direct connection that records the settings of every connect and keeps
/// its output channel open, so the session stays live.
struct RecordingConnection {
    connects: Arc<Mutex<Vec<Value>>>,
    output: Mutex<Option<tokio::sync::mpsc::Sender<Vec<u8>>>>,
}

#[async_trait::async_trait]
impl ConnectionType for RecordingConnection {
    fn type_id(&self) -> &str {
        "recording"
    }
    fn display_name(&self) -> &str {
        "Recording"
    }
    fn settings_schema(&self) -> SettingsSchema {
        SettingsSchema { groups: vec![] }
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
    async fn connect(&mut self, settings: Value) -> Result<(), SessionError> {
        self.connects.lock().unwrap().push(settings);
        Ok(())
    }
    async fn disconnect(&mut self) -> Result<(), SessionError> {
        Ok(())
    }
    fn is_connected(&self) -> bool {
        true
    }
    fn write(&self, _data: &[u8]) -> Result<(), SessionError> {
        Ok(())
    }
    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), SessionError> {
        Ok(())
    }
    fn subscribe_output(&self) -> OutputReceiver {
        let (tx, rx) = tokio::sync::mpsc::channel(8);
        *self.output.lock().unwrap() = Some(tx);
        rx
    }
    fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
        None
    }
    fn file_browser(&self) -> Option<&dyn FileBrowser> {
        None
    }
}

/// A transfer paused because its secret could not be re-sourced, waiting for
/// [`SAVED`] to be opened again.
fn paused_transfer(id: &str) -> PersistedTransfer {
    PersistedTransfer {
        transfer_id: id.to_string(),
        session_id: "sess-before-the-drop".to_string(),
        direction: TransferDirection::Download,
        file_name: "build.log".to_string(),
        remote_path: "/var/log/build.log".to_string(),
        local_path: Some("/tmp/build.log".to_string()),
        status: PersistedTransferStatus::Paused,
        transferred: 4096,
        total: 8192,
        resume_offset: 4096,
        created_at_ms: 1_000,
        updated_at_ms: 2_000,
        docker: None,
        group_id: None,
        folder_paste_id: None,
        source_mtime: None,
        remote_source: None,
        saved_connection_id: Some(SAVED.to_string()),
        agent: None,
        graphical: None,
    }
}

fn poll_until<F: Fn() -> bool>(cond: F, label: &str) {
    for _ in 0..200 {
        if cond() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    panic!("timed out waiting for: {label}");
}

/// What the session-opened hook saw: the triggers, and the transfers each
/// trigger took off the wait list (what `spawn_resume_waiting` resumes).
#[derive(Clone, Default)]
struct Resumed {
    triggers: Arc<Mutex<Vec<WaitTrigger>>>,
    transfers: Arc<Mutex<Vec<String>>>,
}

#[test]
fn a_redriven_session_keeps_its_binding_resumes_transfers_and_keeps_field_secrets() {
    let app = tauri::test::mock_app();
    let handle = app.handle().clone();

    let connects = Arc::new(Mutex::new(Vec::new()));
    let mut registry = ConnectionTypeRegistry::new();
    let factory_connects = connects.clone();
    registry.register(
        "recording",
        "Recording",
        "recording",
        Box::new(move || {
            Box::new(RecordingConnection {
                connects: factory_connects.clone(),
                output: Mutex::new(None),
            })
        }),
    );
    let manager = SessionManager::new(registry, FakeAgent::streaming());

    // The hook boot installs, with the background resume replaced by taking
    // the due rows off a real wait list.
    let waits = Arc::new(CredentialWaits::default());
    let resumed = Resumed::default();
    {
        let (waits, resumed) = (waits.clone(), resumed.clone());
        let transfers = TransferRegistry::new();
        manager.set_session_opened_hook(Arc::new(move |trigger: WaitTrigger| {
            let ids = due(&waits, &trigger, &transfers);
            resumed.transfers.lock().unwrap().extend(ids);
            resumed.triggers.lock().unwrap().push(trigger);
        }));
    }
    handle.manage(manager);

    let store = Arc::new(SessionLifecycleStore::new());
    store.set_rand_for_test(Box::new(|| 0.0));
    handle.manage(store.clone());
    let projection = ProjectionState::new();
    projection
        .projector
        .register_region(SESSION_LIFECYCLE_REGION, store.snapshot());
    let projector = projection.projector.clone();
    let store_for_publish = store.clone();
    handle.manage(projection);

    let scheduler = Arc::new(ManualScheduler::default());
    let redrive: Arc<dyn ReconnectRedrive> = Arc::new(AppReconnectRedrive::new(handle.clone()));
    let driver = Arc::new(
        ReconnectTimerDriver::new(
            store.clone(),
            scheduler.clone(),
            Arc::new(move || {
                publish_sessions(&projector, &store_for_publish);
            }),
        )
        .with_redrive(redrive),
    );
    handle.manage(driver.clone());

    // The user opens the saved connection: the command restored its field
    // secret into the settings (#4289), created the session and bound it.
    let manager = handle.state::<SessionManager>();
    let settings = serde_json::json!({ "host": "build-box", "sshPassword": FIELD_SECRET });
    let first = tauri::async_runtime::block_on(manager.create_connection(
        "recording",
        settings.clone(),
        None,
        Some("tab-1:0"),
        false,
        true, // resilient
        handle.clone(),
    ))
    .expect("initial connect succeeds");
    let origin = SessionOrigin::new(Some(SAVED), None, &settings);
    tauri::async_runtime::block_on(manager.on_session_opened(&first, &origin));
    store.connect("tab-1");
    store.connected("tab-1");
    store.set_backend_session_id("tab-1", Some(first.clone()));
    resumed.triggers.lock().unwrap().clear();

    let mut previous = first;
    for round in 1..=2 {
        // A transfer paused by the drop, waiting for this connection.
        let transfer_id = format!("t{round}");
        note_blocked(
            &waits,
            &paused_transfer(&transfer_id),
            &RelaunchBlocked::NeedsCredentials,
        );

        // The connection drops; the backend redrive reconnects the tab.
        store.reconnect("tab-1");
        driver.sync("tab-1");
        scheduler.fire("tab-1");
        poll_until(
            || {
                let life = store.get("tab-1");
                life.as_ref().map(|l| l.status) == Some(SessionStatus::Connected)
                    && life.and_then(|l| l.backend_session_id).as_deref() != Some(previous.as_str())
            },
            "the redrive reconnects the tab on a new session",
        );
        let redriven = store
            .get("tab-1")
            .and_then(|l| l.backend_session_id)
            .expect("a new backend session id");

        assert_eq!(
            manager.saved_connection_of(&redriven).as_deref(),
            Some(SAVED),
            "round {round}: the redriven session keeps its saved-connection binding"
        );
        assert!(
            tauri::async_runtime::block_on(manager.sessions_for_saved_connection(SAVED))
                .contains(&redriven),
            "round {round}: a relaunch finds the redriven session"
        );
        assert_eq!(
            resumed.triggers.lock().unwrap().last(),
            Some(&WaitTrigger::ConnectionOpened(SAVED.to_string())),
            "round {round}: the redrive fires the transfer-resume trigger"
        );
        assert!(
            resumed.transfers.lock().unwrap().contains(&transfer_id),
            "round {round}: the transfer paused by the drop resumes"
        );
        assert_eq!(
            connects
                .lock()
                .unwrap()
                .last()
                .map(|s| s["sshPassword"].clone()),
            Some(Value::from(FIELD_SECRET)),
            "round {round}: the stored field secret still reaches the connect"
        );
        let retained = manager.retained_request("tab-1").expect("still retained");
        assert_eq!(
            retained.saved_connection_id.as_deref(),
            Some(SAVED),
            "round {round}: the next redrive carries the saved connection too"
        );
        drop(retained);
        previous = redriven;
    }
}
