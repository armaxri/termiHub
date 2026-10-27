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
    /// The backend's hook-free prompt check (#5029), if it has one.
    probe: Option<termihub_core::connection::PromptProbe>,
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
    fn prompt_probe(&self) -> Option<termihub_core::connection::PromptProbe> {
        self.probe.clone()
    }
}

fn prompt_manager(banner: &'static [u8]) -> (SessionManager, Writes) {
    probing_manager(banner, None)
}

fn probing_manager(
    banner: &'static [u8],
    probe: Option<termihub_core::connection::PromptProbe>,
) -> (SessionManager, Writes) {
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
                probe: probe.clone(),
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

/// A backend that can tell when its shell waits at the prompt (#5029) gets
/// the command then — not at the short timeout while its rc file still runs
/// — and exactly the command, typed once.
#[tokio::test]
async fn initial_command_waits_for_the_backends_prompt_probe() {
    let at_prompt = Arc::new(AtomicBool::new(false));
    let probe_flag = at_prompt.clone();
    let probe: termihub_core::connection::PromptProbe =
        Arc::new(move || probe_flag.load(Ordering::SeqCst));
    let (manager, writes) = probing_manager(b"RC-START\r\n", Some(probe));
    let emitter = MockEventEmitter::new();
    open(&manager, &emitter).await;

    tokio::time::sleep(INITIAL_COMMAND_READY_TIMEOUT + Duration::from_millis(500)).await;
    assert!(
        writes.lock().unwrap().is_empty(),
        "the command was typed before the shell reached its prompt"
    );

    at_prompt.store(true, Ordering::SeqCst);
    assert!(
        within(Duration::from_secs(2), || sent(&writes)).await,
        "the command was not typed once the shell reached its prompt"
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(&writes.lock().unwrap()[..], b"echo hi\r");
}

// ── Real shells without the command-mark hook (#5029) ────────────────

/// A real backend whose every write is recorded, so a test can prove the
/// initial command is the only thing termiHub typed into the shell.
struct Recording {
    inner: Box<dyn ConnectionType>,
    writes: Writes,
}

#[async_trait::async_trait]
impl ConnectionType for Recording {
    fn type_id(&self) -> &str {
        self.inner.type_id()
    }
    fn display_name(&self) -> &str {
        self.inner.display_name()
    }
    fn settings_schema(&self) -> SettingsSchema {
        self.inner.settings_schema()
    }
    fn capabilities(&self) -> Capabilities {
        self.inner.capabilities()
    }
    async fn connect(&mut self, settings: serde_json::Value) -> Result<(), SessionError> {
        self.inner.connect(settings).await
    }
    async fn disconnect(&mut self) -> Result<(), SessionError> {
        self.inner.disconnect().await
    }
    fn is_connected(&self) -> bool {
        self.inner.is_connected()
    }
    fn write(&self, data: &[u8]) -> Result<(), SessionError> {
        self.writes.lock().unwrap().extend_from_slice(data);
        self.inner.write(data)
    }
    fn resize(&self, cols: u16, rows: u16) -> Result<(), SessionError> {
        self.inner.resize(cols, rows)
    }
    fn subscribe_output(&self) -> OutputReceiver {
        self.inner.subscribe_output()
    }
    fn prompt_probe(&self) -> Option<termihub_core::connection::PromptProbe> {
        self.inner.prompt_probe()
    }
    fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
        None
    }
    fn file_browser(&self) -> Option<&dyn FileBrowser> {
        None
    }
}

/// A manager whose `type_id` backend comes from `make`, wrapped in a
/// [`Recording`].
fn recording_manager(
    type_id: &'static str,
    make: fn() -> Box<dyn ConnectionType>,
) -> (SessionManager, Writes) {
    let writes = Writes::default();
    let factory_writes = writes.clone();
    let mut registry = ConnectionTypeRegistry::new();
    registry.register(
        type_id,
        type_id,
        "mock",
        Box::new(move || {
            Box::new(Recording {
                inner: make(),
                writes: factory_writes.clone(),
            })
        }),
    );
    (SessionManager::new(registry, Arc::new(NullAgent)), writes)
}

/// Typed as the initial command; its text never contains what it prints.
const SLOW_RC_COMMAND: &str = "echo $((5028+1))-ran";
/// What [`SLOW_RC_COMMAND`] prints.
const SLOW_RC_OUTPUT: &str = "5029-ran";

/// Open `type_id` with `settings` plus the initial command, wait for the
/// command to have run, and check it reached the shell at its prompt: echoed
/// once, after the rc file's output and the prompt (`prompt`), and nothing
/// else typed.
async fn assert_typed_at_the_prompt(
    manager: &SessionManager,
    writes: &Writes,
    type_id: &str,
    mut settings: serde_json::Value,
    prompt: &str,
) {
    settings["initialCommand"] = serde_json::json!(SLOW_RC_COMMAND);
    let emitter = MockEventEmitter::new();
    let session_id = manager
        .create_connection(type_id, settings, None, None, false, false, emitter.clone())
        .await
        .expect("connect succeeds");

    let text = || String::from_utf8_lossy(&emitted(&emitter)).into_owned();
    let ran = within(Duration::from_secs(30), || text().contains(SLOW_RC_OUTPUT)).await;
    // Let a stray second copy (or the shell's next prompt) arrive too.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let out = text();
    let _ = manager.close_session(&session_id).await;
    assert!(ran, "the initial command never ran; output: {out:?}");

    let at = |needle: &str| {
        out.find(needle)
            .unwrap_or_else(|| panic!("{needle:?} missing from the output: {out:?}"))
    };
    let echo = at(SLOW_RC_COMMAND);
    assert!(
        at("RC-DONE") < echo,
        "the initial command was echoed before the rc file finished: {out:?}"
    );
    assert!(
        at(prompt) < echo,
        "the initial command was echoed before the prompt: {out:?}"
    );
    assert_eq!(
        out.matches(SLOW_RC_COMMAND).count(),
        1,
        "the initial command must be echoed exactly once: {out:?}"
    );
    assert_eq!(
        out.matches(SLOW_RC_OUTPUT).count(),
        1,
        "the initial command must run exactly once: {out:?}"
    );
    assert_eq!(
        String::from_utf8_lossy(&writes.lock().unwrap()),
        format!("{SLOW_RC_COMMAND}\r"),
        "termiHub must type the initial command and nothing else"
    );
}

#[cfg(unix)]
fn local_shell() -> Box<dyn ConnectionType> {
    Box::new(termihub_core::backends::local_shell::LocalShell::new())
}

/// The env entries for a local shell test, as `envVars`.
#[cfg(unix)]
fn env_vars(pairs: &[(&str, &str)]) -> serde_json::Value {
    serde_json::Value::Array(
        pairs
            .iter()
            .map(|(k, v)| serde_json::json!({ "key": k, "value": v }))
            .collect(),
    )
}

/// A default (unhooked) local bash whose login rc sleeps 2 s: the initial
/// command waits for bash's line editor instead of being typed into the
/// still-cooked tty, which would echo it ahead of the rc output (#5029).
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_bash_initial_command_waits_for_the_prompt_after_a_slow_rc() {
    let home = tempfile::tempdir().expect("temp home");
    std::fs::write(
        home.path().join(".bash_profile"),
        "echo RC-START\nsleep 2\necho RC-DONE\nPS1='ready-5029$ '\n",
    )
    .expect("write .bash_profile");
    let (manager, writes) = recording_manager("local", local_shell);
    let settings = serde_json::json!({
        "shell": "bash",
        "shellIntegration": false,
        "envVars": env_vars(&[
            ("HOME", home.path().to_str().expect("utf-8 temp path")),
            ("BASH_SILENCE_DEPRECATION_WARNING", "1"),
        ]),
    });
    assert_typed_at_the_prompt(&manager, &writes, "local", settings, "ready-5029$ ").await;
}

/// The zsh twin of the bash test, where zsh is installed.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_zsh_initial_command_waits_for_the_prompt_after_a_slow_rc() {
    if termihub_core::session::shell::detect_available_shells()
        .iter()
        .all(|s| s != "zsh")
    {
        eprintln!("SKIPPED: zsh is not installed");
        return;
    }
    let zdotdir = tempfile::tempdir().expect("temp ZDOTDIR");
    std::fs::write(
        zdotdir.path().join(".zshrc"),
        "echo RC-START\nsleep 2\necho RC-DONE\nPROMPT='ready-5029$ '\n",
    )
    .expect("write .zshrc");
    let (manager, writes) = recording_manager("local", local_shell);
    let settings = serde_json::json!({
        "shell": "zsh",
        "shellIntegration": false,
        "envVars": env_vars(&[(
            "ZDOTDIR",
            zdotdir.path().to_str().expect("utf-8 temp path"),
        )]),
    });
    assert_typed_at_the_prompt(&manager, &writes, "local", settings, "ready-5029$ ").await;
}

/// The rc snippet the SSH test installs in the `ssh-password` fixture's
/// `.bashrc`. It only runs at the test's odd PTY size, so every other
/// session on the shared fixture is untouched.
const SSH_SLOW_RC: &str = "\n# termihub-5029: slow rc for the initial-command test\n\
if [ \"$(stty size 2>/dev/null)\" = \"37 111\" ]; then \
echo RC-START; sleep 2; echo RC-DONE; PS1='ready-5029$ '; fi\n";

/// Add [`SSH_SLOW_RC`] to the fixture user's `.bashrc`, once.
fn install_ssh_slow_rc() {
    let container = termihub_core::test_fixtures::fixture_container("ssh-password");
    let script = "grep -q termihub-5029 ~/.bashrc || printf '%s' \"$1\" >> ~/.bashrc";
    let status = std::process::Command::new("docker")
        .args([
            "exec", "-u", "testuser", &container, "sh", "-c", script, "sh",
        ])
        .arg(SSH_SLOW_RC)
        .status()
        .expect("run docker exec");
    assert!(
        status.success(),
        "installing the slow rc in {container} failed"
    );
}

/// The fixture's host key is unknown; trust it (process-wide, first
/// registration wins, same as the other desktop SSH tests).
fn trust_all_host_keys() {
    use termihub_core::backends::ssh::host_key::{
        set_host_key_verifier, HostKeyInfo, HostKeyVerifier,
    };
    struct TrustAll;
    #[async_trait::async_trait]
    impl HostKeyVerifier for TrustAll {
        async fn verify(&self, _info: &HostKeyInfo) -> bool {
            true
        }
    }
    let _ = set_host_key_verifier(Arc::new(TrustAll));
}

fn ssh_backend() -> Box<dyn ConnectionType> {
    Box::new(termihub_core::backends::ssh::Ssh::new())
}

/// A default (unhooked) bash over a real sshd (the `ssh-password` Docker
/// fixture) whose rc sleeps 2 s: the initial command waits for the remote
/// prompt to settle instead of landing in the still-cooked remote tty
/// (#5029). Skips without the container; hard-fails under
/// `TERMIHUB_REQUIRE_DOCKER=1`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_initial_command_waits_for_the_prompt_after_a_slow_rc() {
    let port = termihub_core::test_fixtures::fixture_port("TERMIHUB_TEST_SSH_PASSWORD_PORT", 2201);
    if !crate::utils::docker_fixture_gate::fixture_ready("ssh-password", port) {
        return;
    }
    install_ssh_slow_rc();
    trust_all_host_keys();
    let (manager, writes) = recording_manager("ssh", ssh_backend);
    let settings = serde_json::json!({
        "host": "127.0.0.1",
        "port": port,
        "username": "testuser",
        "authMethod": "password",
        "password": "testpass",
        "shellIntegration": false,
        "cols": 111,
        "rows": 37,
    });
    assert_typed_at_the_prompt(&manager, &writes, "ssh", settings, "ready-5029$ ").await;
}
