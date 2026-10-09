//! A connection's `initialCommand` must never hide terminal output (#4345).
//!
//! The session used to buffer all output until a full screen clear (or 5 s)
//! whenever an initial command was set, and nothing emits that clear any more
//! on Unix shells. These tests drive `create_connection` with a mock backend
//! that prints a prompt and no clear sequence.

use super::*;

use std::time::{Duration, Instant};

/// Poll `cond` until it holds or `within` passes.
async fn within(within: Duration, mut cond: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if cond() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    cond()
}

fn emitted(emitter: &MockEventEmitter) -> Vec<u8> {
    emitter
        .outputs
        .lock()
        .unwrap()
        .iter()
        .flat_map(|e| e.data.iter().copied())
        .collect()
}

type Writes = Arc<std::sync::Mutex<Vec<u8>>>;

/// Whether the initial command (with the session's line ending) was typed.
fn sent(writes: &Writes) -> bool {
    writes.lock().unwrap().starts_with(b"echo hi\r")
}

/// A connected backend whose output stream starts with `banner` and that
/// records every byte written to it.
struct PromptConnection {
    banner: Vec<u8>,
    writes: Writes,
    // Keeps the output channel open so the reader does not see EOF.
    keep_tx: std::sync::Mutex<Option<tokio::sync::mpsc::Sender<Vec<u8>>>>,
}

#[async_trait::async_trait]
impl ConnectionType for PromptConnection {
    fn type_id(&self) -> &str {
        "prompt"
    }
    fn display_name(&self) -> &str {
        "Prompt"
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
    async fn connect(&mut self, _settings: serde_json::Value) -> Result<(), SessionError> {
        Ok(())
    }
    async fn disconnect(&mut self) -> Result<(), SessionError> {
        Ok(())
    }
    fn is_connected(&self) -> bool {
        true
    }
    fn write(&self, data: &[u8]) -> Result<(), SessionError> {
        self.writes.lock().unwrap().extend_from_slice(data);
        Ok(())
    }
    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), SessionError> {
        Ok(())
    }
    fn subscribe_output(&self) -> OutputReceiver {
        let (tx, rx) = tokio::sync::mpsc::channel(8);
        tx.try_send(self.banner.clone()).expect("banner fits");
        *self.keep_tx.lock().unwrap() = Some(tx);
        rx
    }
    fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
        None
    }
    fn file_browser(&self) -> Option<&dyn FileBrowser> {
        None
    }
}

fn prompt_manager(banner: &'static [u8]) -> (SessionManager, Writes) {
    let writes = Writes::default();
    let factory_writes = writes.clone();
    let mut registry = ConnectionTypeRegistry::new();
    registry.register(
        "prompt",
        "Prompt",
        "mock",
        Box::new(move || {
            Box::new(PromptConnection {
                banner: banner.to_vec(),
                writes: factory_writes.clone(),
                keep_tx: std::sync::Mutex::new(None),
            })
        }),
    );
    (SessionManager::new(registry, Arc::new(NullAgent)), writes)
}

async fn open(manager: &SessionManager, emitter: &MockEventEmitter) -> String {
    manager
        .create_connection(
            "prompt",
            serde_json::json!({ "initialCommand": "echo hi" }),
            None,
            None,
            false,
            false,
            emitter.clone(),
        )
        .await
        .expect("connect succeeds")
}

/// Output produced before the initial command is sent reaches the frontend
/// straight away, even though no screen-clear sequence ever arrives.
#[tokio::test]
async fn initial_command_session_without_clear_flushes_output_promptly() {
    let (manager, _writes) = prompt_manager(b"user@host:~$ ");
    let emitter = MockEventEmitter::new();
    open(&manager, &emitter).await;

    assert!(
        within(Duration::from_secs(1), || emitted(&emitter)
            == b"user@host:~$ ")
        .await,
        "prompt output was held back: {:?}",
        String::from_utf8_lossy(&emitted(&emitter))
    );
}

/// With shell integration the OSC 133 prompt-start mark is the readiness
/// signal: the initial command is typed as soon as it appears.
#[tokio::test]
async fn initial_command_is_sent_on_the_osc133_prompt_mark() {
    let (manager, writes) = prompt_manager(b"\x1b]133;A\x07user@host:~$ ");
    let emitter = MockEventEmitter::new();
    let start = Instant::now();
    open(&manager, &emitter).await;

    assert!(
        within(Duration::from_secs(5), || sent(&writes)).await,
        "initial command was not sent: {:?}",
        String::from_utf8_lossy(&writes.lock().unwrap())
    );
    assert!(
        start.elapsed() < INITIAL_COMMAND_READY_TIMEOUT,
        "the prompt mark must release the command before the fallback timeout"
    );
}

/// Without a prompt mark (no shell integration, remote shells) the command
/// is still sent once the fallback timeout passes.
#[tokio::test]
async fn initial_command_falls_back_to_the_timeout_without_a_prompt_mark() {
    let (manager, writes) = prompt_manager(b"user@host:~$ ");
    let emitter = MockEventEmitter::new();
    open(&manager, &emitter).await;

    assert!(
        within(
            INITIAL_COMMAND_READY_TIMEOUT + Duration::from_secs(4),
            || { sent(&writes) }
        )
        .await,
        "initial command was not sent after the fallback timeout"
    );
}
