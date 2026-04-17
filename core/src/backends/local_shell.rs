//! Local shell backend implementing [`ConnectionType`](crate::connection::ConnectionType).
//!
//! Uses `portable-pty` for cross-platform PTY management via the injected
//! [`LocalShellSpawner`] trait. The default spawner (`NativeLocalShellSpawner`)
//! calls `portable_pty::native_pty_system()`; tests inject `MockLocalShellSpawner`
//! which returns in-memory pipes and never forks a real process.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tracing::{debug, info};

use crate::config::ShellConfig;
use crate::connection::{
    Capabilities, Condition, ConnectionType, FieldType, FilePathKind, OutputReceiver, OutputSender,
    SelectOption, SettingsField, SettingsGroup, SettingsSchema,
};
use crate::errors::SessionError;
use crate::files::{FileBrowser, LocalFileBrowser};
use crate::monitoring::MonitoringProvider;
use crate::session::shell::{
    build_shell_command, detect_available_shells, detect_default_shell, osc7_setup_command,
};
use crate::session::traits::{LocalShellSpawner, SpawnedShell};

/// Channel capacity for output data from the PTY reader thread.
const OUTPUT_CHANNEL_CAPACITY: usize = 64;

// ── NativeLocalShellSpawner ────────────────────────────────────────

/// Production spawner: opens a real PTY pair and forks a process using
/// `portable_pty::native_pty_system()`.
pub struct NativeLocalShellSpawner;

impl LocalShellSpawner for NativeLocalShellSpawner {
    fn spawn(
        &self,
        command: &crate::session::shell::ShellCommand,
    ) -> Result<SpawnedShell, SessionError> {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};

        let pty_system = native_pty_system();
        let pty_pair = pty_system
            .openpty(PtySize {
                rows: command.rows,
                cols: command.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| SessionError::SpawnFailed(e.to_string()))?;

        let mut cmd = CommandBuilder::new(&command.program);
        for arg in &command.args {
            cmd.arg(arg);
        }
        for (key, value) in &command.env {
            cmd.env(key, value);
        }
        if let Some(ref cwd) = command.cwd {
            cmd.cwd(cwd);
        }

        let child = pty_pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| SessionError::SpawnFailed(e.to_string()))?;
        drop(pty_pair.slave);

        let writer = pty_pair
            .master
            .take_writer()
            .map_err(|e| SessionError::SpawnFailed(e.to_string()))?;
        let reader = pty_pair
            .master
            .try_clone_reader()
            .map_err(|e| SessionError::SpawnFailed(e.to_string()))?;

        let master = Arc::new(Mutex::new(pty_pair.master));
        let child = Arc::new(Mutex::new(child));

        let master_for_resize = master.clone();
        let child_for_kill = child.clone();

        Ok(SpawnedShell {
            writer: Box::new(writer),
            reader: Box::new(reader),
            resize: Box::new(move |cols, rows| {
                let m = master_for_resize.lock().map_err(|e| {
                    SessionError::Io(std::io::Error::other(format!("lock failed: {e}")))
                })?;
                m.resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| SessionError::Io(std::io::Error::other(e.to_string())))
            }),
            kill: Box::new(move || {
                if let Ok(mut c) = child_for_kill.lock() {
                    let _ = c.kill();
                }
            }),
        })
    }
}

// ── ConnectedState ─────────────────────────────────────────────────

/// Internal state of an active shell connection.
struct ConnectedState {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    resize: Box<dyn Fn(u16, u16) -> Result<(), SessionError> + Send + Sync>,
    kill: Box<dyn Fn() + Send + Sync>,
    alive: Arc<AtomicBool>,
}

// ── LocalShell ─────────────────────────────────────────────────────

/// Local shell backend using a [`LocalShellSpawner`], implementing
/// [`ConnectionType`].
///
/// Generic over `S` so tests can inject a mock spawner without forking a
/// real PTY. The default is [`NativeLocalShellSpawner`], so callers that
/// just use `LocalShell::new()` get the production behaviour.
///
/// # Lifecycle
///
/// 1. Create with [`LocalShell::new()`] or [`LocalShell::with_spawner()`].
/// 2. Call [`connect()`](ConnectionType::connect) with settings JSON.
/// 3. Use [`write()`](ConnectionType::write),
///    [`resize()`](ConnectionType::resize),
///    [`subscribe_output()`](ConnectionType::subscribe_output) for I/O.
/// 4. Call [`disconnect()`](ConnectionType::disconnect) to clean up.
pub struct LocalShell<S: LocalShellSpawner = NativeLocalShellSpawner> {
    /// State is `None` when disconnected, `Some` when connected.
    state: Option<ConnectedState>,
    /// The output sender is stored so `subscribe_output()` can replace
    /// the channel. The reader thread also holds a reference and picks up
    /// the replacement on its next iteration.
    output_tx: Arc<Mutex<Option<OutputSender>>>,
    /// Local file browser capability.
    file_backend: LocalFileBrowser,
    /// Injected spawn strategy.
    spawner: S,
}

impl LocalShell<NativeLocalShellSpawner> {
    /// Create a new disconnected `LocalShell` using the native PTY spawner.
    pub fn new() -> Self {
        Self::with_spawner(NativeLocalShellSpawner)
    }
}

impl Default for LocalShell<NativeLocalShellSpawner> {
    fn default() -> Self {
        Self::new()
    }
}

impl<S: LocalShellSpawner> LocalShell<S> {
    /// Create a new disconnected `LocalShell` with an injected spawner.
    ///
    /// Useful in tests where `S = MockLocalShellSpawner`.
    pub fn with_spawner(spawner: S) -> Self {
        Self {
            state: None,
            output_tx: Arc::new(Mutex::new(None)),
            file_backend: LocalFileBrowser::new(),
            spawner,
        }
    }
}

#[async_trait::async_trait]
impl<S: LocalShellSpawner> ConnectionType for LocalShell<S> {
    fn type_id(&self) -> &str {
        "local"
    }

    fn display_name(&self) -> &str {
        "Local Shell"
    }

    fn settings_schema(&self) -> SettingsSchema {
        let shells = detect_available_shells();
        let default_shell = detect_default_shell();

        let mut shell_options: Vec<SelectOption> = shells
            .iter()
            .map(|s| {
                let label = if default_shell.as_deref() == Some(s.as_str()) {
                    format!("{s} (default)")
                } else {
                    s.clone()
                };
                SelectOption {
                    value: s.clone(),
                    label,
                }
            })
            .collect();

        shell_options.push(SelectOption {
            value: "custom".to_string(),
            label: "Custom...".to_string(),
        });

        SettingsSchema {
            groups: vec![SettingsGroup {
                key: "shell".to_string(),
                label: "Shell".to_string(),
                fields: vec![
                    SettingsField {
                        key: "shell".to_string(),
                        label: "Shell".to_string(),
                        description: Some("Shell program to use".to_string()),
                        help_text: None,
                        field_type: FieldType::Select {
                            options: shell_options,
                        },
                        required: true,
                        default: default_shell.map(|s| serde_json::json!(s)),
                        placeholder: None,
                        supports_env_expansion: false,
                        supports_tilde_expansion: false,
                        visible_when: None,
                    },
                    SettingsField {
                        key: "customShellPath".to_string(),
                        label: "Shell Executable Path".to_string(),
                        description: Some("Full path to the shell executable".to_string()),
                        help_text: None,
                        field_type: FieldType::Text,
                        required: false,
                        default: None,
                        placeholder: Some("/usr/local/bin/myshell".to_string()),
                        supports_env_expansion: true,
                        supports_tilde_expansion: true,
                        visible_when: Some(Condition {
                            field: "shell".to_string(),
                            equals: serde_json::json!("custom"),
                        }),
                    },
                    SettingsField {
                        key: "startingDirectory".to_string(),
                        label: "Starting Directory".to_string(),
                        description: Some(
                            "Directory to start the shell in (defaults to home)".to_string(),
                        ),
                        help_text: None,
                        field_type: FieldType::FilePath {
                            kind: FilePathKind::Directory,
                        },
                        required: false,
                        default: None,
                        placeholder: Some("~ (home directory)".to_string()),
                        supports_env_expansion: true,
                        supports_tilde_expansion: true,
                        visible_when: None,
                    },
                    SettingsField {
                        key: "initialCommand".to_string(),
                        label: "Initial Command".to_string(),
                        description: Some("Command to run after the shell starts".to_string()),
                        help_text: None,
                        field_type: FieldType::Text,
                        required: false,
                        default: None,
                        placeholder: None,
                        supports_env_expansion: true,
                        supports_tilde_expansion: false,
                        visible_when: None,
                    },
                    SettingsField {
                        key: "shellIntegration".to_string(),
                        label: "Shell Integration".to_string(),
                        description: Some(
                            "Inject OSC 7 CWD tracking at startup (used by the file browser)"
                                .to_string(),
                        ),
                        help_text: Some(concat!(
                            "When enabled, termiHub injects a small shell function at startup ",
                            "that emits OSC 7 (current working directory) sequences on every prompt.\n\n",
                            "This lets the file browser automatically follow the current directory ",
                            "as you navigate in the shell.\n\n",
                            "The setup runs visibly in the terminal — you can always see what ",
                            "termiHub is doing. Disable this if you manage your own shell ",
                            "integration or prefer a clean terminal start.",
                        ).to_string()),
                        field_type: FieldType::Boolean,
                        required: false,
                        default: Some(serde_json::json!(true)),
                        placeholder: None,
                        supports_env_expansion: false,
                        supports_tilde_expansion: false,
                        visible_when: None,
                    },
                ],
            }],
        }
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            monitoring: false,
            file_browser: true,
            resize: true,
            persistent: false,
        }
    }

    async fn connect(&mut self, settings: serde_json::Value) -> Result<(), SessionError> {
        if self.state.is_some() {
            return Err(SessionError::AlreadyExists("Already connected".to_string()));
        }

        // Parse settings into ShellConfig.
        // Fall back to legacy "shellType" key for old saved connections.
        let shell = settings
            .get("shell")
            .or_else(|| settings.get("shellType"))
            .and_then(|v| v.as_str())
            .map(String::from);

        // When "custom" is selected, use the customShellPath value instead.
        let shell = if shell.as_deref() == Some("custom") {
            settings
                .get("customShellPath")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(String::from)
        } else {
            shell
        };
        let starting_directory = settings
            .get("startingDirectory")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(String::from);
        let initial_command = settings
            .get("initialCommand")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(String::from);
        let shell_integration = settings
            .get("shellIntegration")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);

        // Resolve effective shell name for OSC 7 injection below.
        let effective_shell = shell
            .clone()
            .or_else(detect_default_shell)
            .unwrap_or_else(|| "sh".to_string());

        let config = ShellConfig {
            shell: Some(effective_shell.clone()),
            starting_directory,
            initial_command,
            ..ShellConfig::default()
        }
        .expand();

        let shell_cmd = build_shell_command(&config);

        // Determine OSC 7 CWD tracking injection strategy.
        let osc7_setup = if shell_integration {
            osc7_setup_command(&effective_shell)
        } else {
            None
        };

        // Build the final command. For PowerShell / cmd, fold the OSC 7 setup
        // into startup flags so it runs before the first prompt. For all other
        // shells, keep `osc7_for_stdin` to inject via stdin after spawn.
        let uses_startup_args = matches!(effective_shell.as_str(), "powershell" | "cmd");
        let mut final_cmd = shell_cmd;
        let osc7_for_stdin = if uses_startup_args {
            if let Some(setup) = osc7_setup {
                match effective_shell.as_str() {
                    "powershell" => {
                        final_cmd.args.push("-NoExit".to_string());
                        final_cmd.args.push("-Command".to_string());
                        final_cmd.args.push(setup.to_string());
                    }
                    "cmd" => {
                        final_cmd.args.push("/K".to_string());
                        final_cmd.args.push(setup.to_string());
                    }
                    _ => {}
                }
            }
            None
        } else {
            osc7_setup
        };

        info!(program = %final_cmd.program, "Spawning local shell");

        // Spawn PTY/process via injected spawner.
        let spawned = self
            .spawner
            .spawn(&final_cmd)
            .map_err(|e| SessionError::SpawnFailed(e.to_string()))?;

        let alive = Arc::new(AtomicBool::new(true));

        // Set up output channel.
        let (tx, _rx) = tokio::sync::mpsc::channel(OUTPUT_CHANNEL_CAPACITY);
        {
            let mut guard = self
                .output_tx
                .lock()
                .map_err(|e| SessionError::SpawnFailed(format!("Failed to lock output_tx: {e}")))?;
            *guard = Some(tx);
        }

        // Spawn reader thread: bridges sync PTY reads to async tokio channel.
        let mut reader = spawned.reader;
        let alive_clone = alive.clone();
        let output_tx_clone = self.output_tx.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = buf[..n].to_vec();
                        let guard = output_tx_clone.lock().ok();
                        if let Some(ref guard) = guard {
                            if let Some(ref sender) = **guard {
                                // blocking_send blocks if channel full (backpressure).
                                let _ = sender.blocking_send(data);
                            } else {
                                break;
                            }
                        } else {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            alive_clone.store(false, Ordering::SeqCst);
            if let Ok(mut guard) = output_tx_clone.lock() {
                *guard = None;
            }
        });

        self.state = Some(ConnectedState {
            writer: Arc::new(Mutex::new(spawned.writer)),
            resize: spawned.resize,
            kill: spawned.kill,
            alive,
        });

        // Inject OSC 7 PROMPT_COMMAND hook for CWD tracking via stdin.
        // PowerShell and cmd already received it via startup args above.
        // Errors are non-fatal — the shell works without CWD tracking.
        if let Some(setup) = osc7_for_stdin {
            let cmd = format!("{setup}\n");
            if let Err(e) = self.write(cmd.as_bytes()) {
                debug!("Failed to inject OSC 7 hook: {e}");
            }
        }

        Ok(())
    }

    async fn disconnect(&mut self) -> Result<(), SessionError> {
        if let Some(state) = self.state.take() {
            state.alive.store(false, Ordering::SeqCst);
            (state.kill)();
            // Clear the sender to signal the reader thread to stop.
            if let Ok(mut guard) = self.output_tx.lock() {
                *guard = None;
            }
            debug!("Local shell disconnected");
        }
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.state
            .as_ref()
            .is_some_and(|s| s.alive.load(Ordering::SeqCst))
    }

    fn write(&self, data: &[u8]) -> Result<(), SessionError> {
        let state = self
            .state
            .as_ref()
            .ok_or_else(|| SessionError::NotRunning("Not connected".to_string()))?;
        let mut writer = state.writer.lock().map_err(|e| {
            SessionError::Io(std::io::Error::other(format!("Failed to lock writer: {e}")))
        })?;
        writer.write_all(data).map_err(SessionError::Io)?;
        writer.flush().map_err(SessionError::Io)?;
        Ok(())
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), SessionError> {
        let state = self
            .state
            .as_ref()
            .ok_or_else(|| SessionError::NotRunning("Not connected".to_string()))?;
        (state.resize)(cols, rows)
    }

    fn subscribe_output(&self) -> OutputReceiver {
        let (tx, rx) = tokio::sync::mpsc::channel(OUTPUT_CHANNEL_CAPACITY);
        if let Ok(mut guard) = self.output_tx.lock() {
            *guard = Some(tx);
        }
        rx
    }

    fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
        None
    }

    fn file_browser(&self) -> Option<&dyn FileBrowser> {
        Some(&self.file_backend)
    }
}

// ── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    use crate::connection::validate_settings;
    use crate::session::shell::ShellCommand;
    use crate::session::traits::SpawnedShell;

    // ── MockLocalShellSpawner ────────────────────────────────────────

    /// Logs bytes written to the spawned process's stdin.
    struct LogWriter {
        log: Arc<Mutex<Vec<Vec<u8>>>>,
    }

    impl Write for LogWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.log.lock().unwrap().push(buf.to_vec());
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// Blocks in `read()` until the sender is dropped (simulates a live process).
    ///
    /// When the sender is dropped (via `kill()`), `rx.recv()` returns `Err`,
    /// and `read()` returns `Ok(0)` (EOF), allowing the reader thread to exit cleanly.
    struct ChannelReader {
        rx: std::sync::mpsc::Receiver<Vec<u8>>,
        current: std::io::Cursor<Vec<u8>>,
    }

    impl Read for ChannelReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            loop {
                let n = self.current.read(buf)?;
                if n > 0 {
                    return Ok(n);
                }
                // Current buffer exhausted — wait for next chunk or EOF
                match self.rx.recv() {
                    Ok(chunk) => self.current = std::io::Cursor::new(chunk),
                    // Sender dropped → signal EOF
                    Err(_) => return Ok(0),
                }
            }
        }
    }

    struct MockLocalShellSpawner {
        /// When `true`, `spawn()` returns an error.
        should_fail: bool,
        /// Shared log of bytes written via the mock writer.
        write_log: Arc<Mutex<Vec<Vec<u8>>>>,
        /// Shared log of resize calls `(cols, rows)`.
        resize_log: Arc<Mutex<Vec<(u16, u16)>>>,
        /// Set to `true` when kill is invoked.
        killed: Arc<AtomicBool>,
        /// Dropping this sender signals EOF to the `ChannelReader`.
        reader_tx: Arc<Mutex<Option<std::sync::mpsc::SyncSender<Vec<u8>>>>>,
    }

    impl MockLocalShellSpawner {
        fn new() -> Self {
            Self {
                should_fail: false,
                write_log: Arc::new(Mutex::new(Vec::new())),
                resize_log: Arc::new(Mutex::new(Vec::new())),
                killed: Arc::new(AtomicBool::new(false)),
                reader_tx: Arc::new(Mutex::new(None)),
            }
        }

        fn failing() -> Self {
            Self {
                should_fail: true,
                ..Self::new()
            }
        }
    }

    impl LocalShellSpawner for MockLocalShellSpawner {
        fn spawn(&self, _command: &ShellCommand) -> Result<SpawnedShell, SessionError> {
            if self.should_fail {
                return Err(SessionError::SpawnFailed("mock spawn failure".to_string()));
            }
            let write_log = self.write_log.clone();
            let resize_log = self.resize_log.clone();
            let killed = self.killed.clone();
            let reader_tx_slot = self.reader_tx.clone();

            // Bounded-0 channel: no buffering; drop sender to signal EOF.
            let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(0);
            *reader_tx_slot.lock().unwrap() = Some(tx);

            Ok(SpawnedShell {
                writer: Box::new(LogWriter { log: write_log }),
                reader: Box::new(ChannelReader {
                    rx,
                    current: std::io::Cursor::new(Vec::new()),
                }),
                resize: Box::new(move |c, r| {
                    resize_log.lock().unwrap().push((c, r));
                    Ok(())
                }),
                kill: Box::new(move || {
                    killed.store(true, Ordering::SeqCst);
                    // Drop the sender → ChannelReader.read() returns Ok(0) (EOF)
                    *reader_tx_slot.lock().unwrap() = None;
                }),
            })
        }
    }

    fn valid_settings() -> serde_json::Value {
        let shells = detect_available_shells();
        let shell = shells.first().cloned().unwrap_or_else(|| "sh".to_string());
        serde_json::json!({ "shell": shell })
    }

    // ── Unit tests (no real PTY) ─────────────────────────────────────

    #[test]
    fn type_id() {
        let shell = LocalShell::new();
        assert_eq!(shell.type_id(), "local");
    }

    #[test]
    fn display_name() {
        let shell = LocalShell::new();
        assert_eq!(shell.display_name(), "Local Shell");
    }

    #[test]
    fn capabilities() {
        let shell = LocalShell::new();
        let caps = shell.capabilities();
        assert!(caps.resize);
        assert!(!caps.monitoring);
        assert!(caps.file_browser);
        assert!(!caps.persistent);
    }

    #[test]
    fn file_browser_returns_some() {
        let shell = LocalShell::new();
        assert!(shell.file_browser().is_some());
    }

    #[test]
    fn not_connected_initially() {
        let shell = LocalShell::new();
        assert!(!shell.is_connected());
    }

    #[test]
    fn schema_has_shell_field() {
        let shell = LocalShell::new();
        let schema = shell.settings_schema();
        assert!(!schema.groups.is_empty());
        let fields = &schema.groups[0].fields;
        assert!(fields.iter().any(|f| f.key == "shell"));
    }

    #[test]
    fn schema_shell_options_not_empty() {
        let shell = LocalShell::new();
        let schema = shell.settings_schema();
        let shell_field = schema.groups[0]
            .fields
            .iter()
            .find(|f| f.key == "shell")
            .unwrap();
        if let FieldType::Select { options } = &shell_field.field_type {
            assert!(!options.is_empty(), "shell options should not be empty");
        } else {
            panic!("expected Select field type for shell");
        }
    }

    #[test]
    fn schema_default_shell_has_default_label() {
        let shell = LocalShell::new();
        let schema = shell.settings_schema();
        let shell_field = schema.groups[0]
            .fields
            .iter()
            .find(|f| f.key == "shell")
            .unwrap();
        if let FieldType::Select { options } = &shell_field.field_type {
            let default_shell = detect_default_shell();
            if let Some(ref ds) = default_shell {
                let default_opt = options.iter().find(|o| o.value == *ds);
                assert!(default_opt.is_some(), "default shell should be in options");
                assert!(
                    default_opt.unwrap().label.ends_with("(default)"),
                    "default shell label should end with '(default)', got: {}",
                    default_opt.unwrap().label
                );
            }
            for opt in options {
                if Some(opt.value.as_str()) != default_shell.as_deref() {
                    assert!(
                        !opt.label.contains("(default)"),
                        "non-default shell '{}' should not have '(default)' in label",
                        opt.value
                    );
                }
            }
        } else {
            panic!("expected Select field type for shell");
        }
    }

    #[test]
    fn schema_includes_custom_shell_option() {
        let shell = LocalShell::new();
        let schema = shell.settings_schema();
        let shell_field = schema.groups[0]
            .fields
            .iter()
            .find(|f| f.key == "shell")
            .unwrap();
        if let FieldType::Select { options } = &shell_field.field_type {
            let custom_opt = options.iter().find(|o| o.value == "custom");
            assert!(
                custom_opt.is_some(),
                "expected 'custom' option in shell select"
            );
            assert_eq!(custom_opt.unwrap().label, "Custom...");
        } else {
            panic!("expected Select field type for shell");
        }
    }

    #[test]
    fn schema_has_custom_shell_path_field() {
        let shell = LocalShell::new();
        let schema = shell.settings_schema();
        let fields = &schema.groups[0].fields;
        let path_field = fields.iter().find(|f| f.key == "customShellPath");
        assert!(path_field.is_some(), "expected customShellPath field");
        let f = path_field.unwrap();
        assert!(f.supports_tilde_expansion);
        assert!(f.supports_env_expansion);
        assert!(
            f.visible_when.is_some(),
            "customShellPath should have visible_when condition"
        );
        let condition = f.visible_when.as_ref().unwrap();
        assert_eq!(condition.field, "shell");
        assert_eq!(condition.equals, serde_json::json!("custom"));
    }

    #[test]
    fn schema_has_starting_directory() {
        let shell = LocalShell::new();
        let schema = shell.settings_schema();
        let fields = &schema.groups[0].fields;
        let dir_field = fields.iter().find(|f| f.key == "startingDirectory");
        assert!(dir_field.is_some());
        let f = dir_field.unwrap();
        assert!(!f.required);
        assert!(f.supports_tilde_expansion);
        assert!(f.supports_env_expansion);
    }

    #[test]
    fn schema_has_initial_command() {
        let shell = LocalShell::new();
        let schema = shell.settings_schema();
        let fields = &schema.groups[0].fields;
        let cmd_field = fields.iter().find(|f| f.key == "initialCommand");
        assert!(cmd_field.is_some());
        let f = cmd_field.unwrap();
        assert!(!f.required);
    }

    #[test]
    fn write_when_disconnected_errors() {
        let shell = LocalShell::new();
        let result = shell.write(b"hello");
        assert!(result.is_err());
    }

    #[test]
    fn resize_when_disconnected_errors() {
        let shell = LocalShell::new();
        let result = shell.resize(80, 24);
        assert!(result.is_err());
    }

    #[test]
    fn validation_missing_shell_fails() {
        let shell = LocalShell::new();
        let schema = shell.settings_schema();
        let settings = serde_json::json!({});
        let errors = validate_settings(&schema, &settings);
        assert!(!errors.is_empty());
        assert!(errors.iter().any(|e| e.field == "shell"));
    }

    #[test]
    fn validation_valid_settings_passes() {
        let shell = LocalShell::new();
        let schema = shell.settings_schema();
        let shells = detect_available_shells();
        if let Some(first_shell) = shells.first() {
            let settings = serde_json::json!({
                "shell": first_shell,
            });
            let errors = validate_settings(&schema, &settings);
            assert!(errors.is_empty(), "errors: {errors:?}");
        }
    }

    #[test]
    fn default_creates_disconnected() {
        let shell = LocalShell::default();
        assert!(!shell.is_connected());
    }

    // ── DI unit tests (use mock spawner, no real PTY) ────────────────

    #[tokio::test]
    async fn spawn_failure_propagates_as_connect_error() {
        let mut shell = LocalShell::with_spawner(MockLocalShellSpawner::failing());
        let result = shell.connect(valid_settings()).await;
        assert!(result.is_err(), "connect should fail when spawner fails");
        assert!(!shell.is_connected());
    }

    #[tokio::test]
    async fn connect_already_connected_fails_with_mock() {
        let mock = MockLocalShellSpawner::new();
        let mut shell = LocalShell::with_spawner(mock);

        shell
            .connect(valid_settings())
            .await
            .expect("first connect");
        let result = shell.connect(valid_settings()).await;
        assert!(result.is_err(), "second connect should fail");

        shell.disconnect().await.ok();
    }

    #[tokio::test]
    async fn resize_delegated_to_spawner() {
        let mock = MockLocalShellSpawner::new();
        let resize_log = mock.resize_log.clone();

        let mut shell = LocalShell::with_spawner(mock);
        shell.connect(valid_settings()).await.expect("connect");

        shell.resize(120, 40).expect("resize");
        shell.resize(80, 24).expect("resize");

        {
            let log = resize_log.lock().unwrap();
            assert_eq!(log.len(), 2);
            assert_eq!(log[0], (120, 40));
            assert_eq!(log[1], (80, 24));
        }

        shell.disconnect().await.ok();
    }

    #[tokio::test]
    async fn disconnect_invokes_kill() {
        let mock = MockLocalShellSpawner::new();
        let killed = mock.killed.clone();

        let mut shell = LocalShell::with_spawner(mock);
        shell.connect(valid_settings()).await.expect("connect");
        assert!(!killed.load(Ordering::SeqCst));

        shell.disconnect().await.expect("disconnect");
        assert!(
            killed.load(Ordering::SeqCst),
            "kill should be called on disconnect"
        );
    }

    #[tokio::test]
    async fn write_routed_through_mock_writer() {
        let mock = MockLocalShellSpawner::new();
        let write_log = mock.write_log.clone();

        let mut shell = LocalShell::with_spawner(mock);
        shell.connect(valid_settings()).await.expect("connect");
        shell.write(b"hello world").expect("write");

        {
            let log = write_log.lock().unwrap();
            let all_bytes: Vec<u8> = log.iter().flat_map(|v| v.iter().copied()).collect();
            assert!(
                all_bytes.windows(11).any(|w| w == b"hello world"),
                "write_log should contain 'hello world', got: {all_bytes:?}"
            );
        }

        shell.disconnect().await.ok();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn osc7_setup_injected_via_stdin_for_bash() {
        let mock = MockLocalShellSpawner::new();
        let write_log = mock.write_log.clone();

        let mut shell = LocalShell::with_spawner(mock);
        let settings = serde_json::json!({
            "shell": "bash",
            "shellIntegration": true,
        });
        shell.connect(settings).await.expect("connect");

        // After connect(), the OSC7 hook is written to stdin.
        {
            let log = write_log.lock().unwrap();
            let all: Vec<u8> = log.iter().flat_map(|v| v.iter().copied()).collect();
            let text = String::from_utf8_lossy(&all);
            assert!(
                text.contains("__termihub_osc7") || text.contains("PROMPT_COMMAND"),
                "OSC7 hook should be written to stdin for bash, got: {text:?}"
            );
        }

        shell.disconnect().await.ok();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn osc7_not_injected_via_stdin_when_disabled() {
        let mock = MockLocalShellSpawner::new();
        let write_log = mock.write_log.clone();

        let mut shell = LocalShell::with_spawner(mock);
        let settings = serde_json::json!({
            "shell": "bash",
            "shellIntegration": false,
        });
        shell.connect(settings).await.expect("connect");

        {
            let log = write_log.lock().unwrap();
            let all: Vec<u8> = log.iter().flat_map(|v| v.iter().copied()).collect();
            let text = String::from_utf8_lossy(&all);
            assert!(
                !text.contains("__termihub_osc7"),
                "OSC7 should not be written when shellIntegration=false, got: {text:?}"
            );
        }

        shell.disconnect().await.ok();
    }

    #[tokio::test]
    async fn disconnect_when_not_connected_is_noop_with_mock() {
        let mut shell = LocalShell::with_spawner(MockLocalShellSpawner::new());
        shell.disconnect().await.expect("should not fail");
    }

    #[tokio::test]
    async fn is_connected_true_after_connect_with_mock() {
        let mock = MockLocalShellSpawner::new();
        let mut shell = LocalShell::with_spawner(mock);
        shell.connect(valid_settings()).await.expect("connect");
        assert!(shell.is_connected());
        shell.disconnect().await.ok();
    }

    // ── Integration tests (spawn real shells, require PTY) ───────────

    #[tokio::test]
    async fn connect_and_receive_output() {
        let mut shell = LocalShell::new();

        let shells = detect_available_shells();
        let shell_name = shells.first().expect("at least one shell available");

        let settings = serde_json::json!({
            "shell": shell_name,
        });

        shell.connect(settings).await.expect("connect failed");
        assert!(shell.is_connected());

        let mut rx = shell.subscribe_output();
        shell.write(b"echo HELLO_TERMIHUB\n").expect("write failed");

        let mut output = Vec::new();
        let deadline = tokio::time::Duration::from_secs(5);
        let result = tokio::time::timeout(deadline, async {
            while let Some(chunk) = rx.recv().await {
                output.extend_from_slice(&chunk);
                let text = String::from_utf8_lossy(&output);
                if text.contains("HELLO_TERMIHUB") {
                    return true;
                }
            }
            false
        })
        .await;

        assert!(
            result.unwrap_or(false),
            "expected HELLO_TERMIHUB in output, got: {}",
            String::from_utf8_lossy(&output)
        );

        shell.resize(120, 40).expect("resize failed");
        shell.disconnect().await.expect("disconnect failed");
        assert!(!shell.is_connected());
    }

    #[tokio::test]
    async fn connect_already_connected_fails() {
        let mut shell = LocalShell::new();
        let shells = detect_available_shells();
        let shell_name = shells.first().expect("at least one shell available");
        let settings = serde_json::json!({ "shell": shell_name });

        shell
            .connect(settings.clone())
            .await
            .expect("first connect");
        let result = shell.connect(settings).await;
        assert!(result.is_err());

        shell.disconnect().await.ok();
    }

    #[tokio::test]
    async fn subscribe_output_replaces_previous() {
        let mut shell = LocalShell::new();
        let shells = detect_available_shells();
        let shell_name = shells.first().expect("at least one shell available");
        let settings = serde_json::json!({ "shell": shell_name });

        shell.connect(settings).await.expect("connect failed");

        let _rx1 = shell.subscribe_output();
        let mut rx2 = shell.subscribe_output();

        shell.write(b"echo TEST_REPLACE\n").expect("write failed");

        let mut output = Vec::new();
        let deadline = tokio::time::Duration::from_secs(5);
        let _ = tokio::time::timeout(deadline, async {
            while let Some(chunk) = rx2.recv().await {
                output.extend_from_slice(&chunk);
                if String::from_utf8_lossy(&output).contains("TEST_REPLACE") {
                    return;
                }
            }
        })
        .await;

        assert!(
            String::from_utf8_lossy(&output).contains("TEST_REPLACE"),
            "expected output on second subscriber"
        );

        shell.disconnect().await.ok();
    }

    #[tokio::test]
    async fn disconnect_when_not_connected_is_noop() {
        let mut shell = LocalShell::new();
        shell
            .disconnect()
            .await
            .expect("disconnect should not fail");
    }

    /// Regression test for #408: verify the OSC 7 PROMPT_COMMAND hook is
    /// injected into local bash sessions by checking for the `__termihub_osc7`
    /// function definition in the echoed output.
    #[cfg(unix)]
    #[tokio::test]
    async fn osc7_setup_injected_for_bash() {
        use std::path::Path;

        if !Path::new("/bin/bash").exists() && !Path::new("/usr/bin/bash").exists() {
            eprintln!("bash not found — skipping OSC 7 injection test");
            return;
        }

        let mut shell = LocalShell::new();
        let settings = serde_json::json!({ "shell": "bash" });

        shell.connect(settings).await.expect("connect failed");
        let mut rx = shell.subscribe_output();

        let mut output = Vec::new();
        let deadline = tokio::time::Duration::from_secs(5);
        let found = tokio::time::timeout(deadline, async {
            while let Some(chunk) = rx.recv().await {
                output.extend_from_slice(&chunk);
                let text = String::from_utf8_lossy(&output);
                if text.contains("__termihub_osc7") && text.contains("PROMPT_COMMAND") {
                    return true;
                }
            }
            false
        })
        .await;

        assert!(
            found.unwrap_or(false),
            "expected OSC 7 setup (__termihub_osc7 + PROMPT_COMMAND) in bash output, got: {:?}",
            String::from_utf8_lossy(&output)
        );

        shell.disconnect().await.ok();
    }

    /// Old saved connections use `"shellType"` instead of `"shell"`.
    #[tokio::test]
    async fn connect_with_legacy_shell_type_key() {
        let mut shell = LocalShell::new();
        let shells = detect_available_shells();
        let shell_name = shells.first().expect("at least one shell available");

        let settings = serde_json::json!({ "shellType": shell_name });

        shell
            .connect(settings)
            .await
            .expect("connect with legacy shellType key should succeed");
        assert!(shell.is_connected());

        shell.disconnect().await.ok();
    }
}
