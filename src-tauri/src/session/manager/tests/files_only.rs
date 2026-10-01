//! Files-only sessions (#4078): the manager forwards a backend's files-only
//! verdict to the tab's lifecycle entry, keeps the session, and never ends it.

use super::*;

/// A connection that reports files-only on demand, holding its output open
/// (as the SSH backend does once the shell was refused but SFTP works).
struct FilesOnlyConnection {
    files_only: Arc<tokio::sync::watch::Sender<bool>>,
    output: std::sync::Mutex<Option<tokio::sync::mpsc::Sender<Vec<u8>>>>,
}

#[async_trait::async_trait]
impl ConnectionType for FilesOnlyConnection {
    fn type_id(&self) -> &str {
        "files-only-mock"
    }
    fn display_name(&self) -> &str {
        "Files-only Mock"
    }
    fn settings_schema(&self) -> SettingsSchema {
        SettingsSchema { groups: vec![] }
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            monitoring: false,
            file_browser: true,
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
        true
    }
    fn write(&self, _data: &[u8]) -> Result<(), SessionError> {
        Ok(())
    }
    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), SessionError> {
        Ok(())
    }
    fn subscribe_output(&self) -> OutputReceiver {
        let (tx, rx) = tokio::sync::mpsc::channel(1);
        *self.output.lock().unwrap() = Some(tx);
        rx
    }
    fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
        None
    }
    fn file_browser(&self) -> Option<&dyn FileBrowser> {
        None
    }
    fn files_only_watch(&self) -> Option<tokio::sync::watch::Receiver<bool>> {
        Some(self.files_only.subscribe())
    }
}

/// An emitter recording `fold_files_only` and exits.
#[derive(Clone, Default)]
struct FilesOnlyEmitter {
    files_only: Arc<std::sync::Mutex<Vec<String>>>,
    exits: Arc<std::sync::Mutex<Vec<String>>>,
}

impl EventEmitter for FilesOnlyEmitter {
    fn emit_output(&self, _event: &TerminalOutputEvent) -> bool {
        true
    }
    fn emit_exit(&self, event: &TerminalExitEvent) {
        self.exits.lock().unwrap().push(event.session_id.clone());
    }
    fn fold_files_only(&self, tab_id: &str) {
        self.files_only.lock().unwrap().push(tab_id.to_string());
    }
}

/// A manager whose `files-only-mock` type shares one files-only switch.
fn manager() -> (SessionManager, Arc<tokio::sync::watch::Sender<bool>>) {
    let switch = Arc::new(tokio::sync::watch::channel(false).0);
    let factory_switch = switch.clone();
    let mut registry = ConnectionTypeRegistry::new();
    registry.register(
        "files-only-mock",
        "Files-only Mock",
        "mock",
        Box::new(move || {
            Box::new(FilesOnlyConnection {
                files_only: factory_switch.clone(),
                output: std::sync::Mutex::new(None),
            })
        }),
    );
    (SessionManager::new(registry, Arc::new(NullAgent)), switch)
}

async fn open(manager: &SessionManager, emitter: &FilesOnlyEmitter, connect_id: &str) -> String {
    manager
        .create_connection(
            "files-only-mock",
            serde_json::json!({}),
            None,
            Some(connect_id),
            false,
            true,
            emitter.clone(),
        )
        .await
        .expect("session should open")
}

async fn wait_until(mut done: impl FnMut() -> bool) -> bool {
    for _ in 0..100 {
        if done() {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    done()
}

#[tokio::test]
async fn a_files_only_verdict_folds_onto_the_tab_and_keeps_the_session() {
    let (manager, switch) = manager();
    let emitter = FilesOnlyEmitter::default();
    let session_id = open(&manager, &emitter, "tab-sftp:0").await;

    switch.send_replace(true);

    assert!(
        wait_until(|| !emitter.files_only.lock().unwrap().is_empty()).await,
        "the files-only verdict must be folded"
    );
    assert_eq!(
        *emitter.files_only.lock().unwrap(),
        vec!["tab-sftp".to_string()]
    );
    assert!(
        emitter.exits.lock().unwrap().is_empty(),
        "a files-only session must not exit (no drop, no reconnect)"
    );
    assert!(
        manager.sessions.lock().await.contains_key(&session_id),
        "the session stays registered for the file browser"
    );
}

#[tokio::test]
async fn a_session_closed_before_the_verdict_folds_nothing() {
    let (manager, switch) = manager();
    let emitter = FilesOnlyEmitter::default();
    let session_id = open(&manager, &emitter, "tab-gone:0").await;

    manager.close_session(&session_id).await.expect("close");
    switch.send_replace(true);
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    assert!(
        emitter.files_only.lock().unwrap().is_empty(),
        "a closed session's watcher must have stopped"
    );
}

#[tokio::test]
async fn a_session_without_a_tab_folds_nothing() {
    let (manager, switch) = manager();
    let emitter = FilesOnlyEmitter::default();
    manager
        .create_connection(
            "files-only-mock",
            serde_json::json!({}),
            None,
            None,
            false,
            false,
            emitter.clone(),
        )
        .await
        .expect("session should open");

    switch.send_replace(true);
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(emitter.files_only.lock().unwrap().is_empty());
}
