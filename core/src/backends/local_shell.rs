//! Local shell backend implementing [`ConnectionType`](crate::connection::ConnectionType).
//!
//! Uses `portable-pty` for cross-platform PTY management. This is the
//! canonical local shell implementation, used by both the desktop and
//! agent crates (the desktop crate previously had its own implementation
//! in `src-tauri/src/terminal/local_shell.rs`).

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tracing::{debug, info};

use crate::config::ShellConfig;
use crate::connection::{
    Capabilities, ConnectionType, FieldType, FilePathKind, OutputReceiver, OutputSender,
    SelectOption, SettingsField, SettingsGroup, SettingsSchema,
};
use crate::errors::SessionError;
use crate::files::FileBrowser;
use crate::monitoring::MonitoringProvider;
use crate::session::shell::{build_shell_command, detect_available_shells, detect_default_shell};

/// Channel capacity for output data from the PTY reader thread.
const OUTPUT_CHANNEL_CAPACITY: usize = 64;

/// Local shell backend using portable-pty, implementing [`ConnectionType`].
///
/// # Lifecycle
///
/// 1. Create with [`LocalShell::new()`] (disconnected state).
/// 2. Call [`connect()`](ConnectionType::connect) with settings JSON.
/// 3. Use [`write()`](ConnectionType::write),
///    [`resize()`](ConnectionType::resize),
///    [`subscribe_output()`](ConnectionType::subscribe_output) for I/O.
/// 4. Call [`disconnect()`](ConnectionType::disconnect) to clean up.
pub struct LocalShell {
    /// State is `None` when disconnected, `Some` when connected.
    state: Option<ConnectedState>,
    /// The output sender is stored so `subscribe_output()` can replace
    /// the channel. The reader thread also holds a reference and picks up
    /// the replacement on its next iteration.
    output_tx: Arc<Mutex<Option<OutputSender>>>,
}

/// Internal state of an active shell connection.
struct ConnectedState {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    alive: Arc<AtomicBool>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send>>>,
}

impl LocalShell {
    /// Create a new disconnected `LocalShell` instance.
    pub fn new() -> Self {
        Self {
            state: None,
            output_tx: Arc::new(Mutex::new(None)),
        }
    }
}

impl Default for LocalShell {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl ConnectionType for LocalShell {
    fn type_id(&self) -> &str {
        "local"
    }

    fn display_name(&self) -> &str {
        "Local Shell"
    }

    fn settings_schema(&self) -> SettingsSchema {
        let shells = detect_available_shells();
        let default_shell = detect_default_shell();

        let shell_options: Vec<SelectOption> = shells
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

        SettingsSchema {
            groups: vec![SettingsGroup {
                key: "shell".to_string(),
                label: "Shell".to_string(),
                fields: vec![
                    SettingsField {
                        key: "shell".to_string(),
                        label: "Shell".to_string(),
                        description: Some("Shell program to use".to_string()),
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
                        key: "startingDirectory".to_string(),
                        label: "Starting Directory".to_string(),
                        description: Some(
                            "Directory to start the shell in (defaults to home)".to_string(),
                        ),
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
                        field_type: FieldType::Text,
                        required: false,
                        default: None,
                        placeholder: None,
                        supports_env_expansion: true,
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
            file_browser: false,
            resize: true,
            persistent: false,
        }
    }

    async fn connect(&mut self, settings: serde_json::Value) -> Result<(), SessionError> {
        if self.state.is_some() {
            return Err(SessionError::AlreadyExists("Already connected".to_string()));
        }

        // Parse settings into ShellConfig.
        let shell = settings
            .get("shell")
            .and_then(|v| v.as_str())
            .map(String::from);
        let starting_directory = settings
            .get("startingDirectory")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(String::from);
        let _initial_command = settings
            .get("initialCommand")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(String::from);

        let config = ShellConfig {
            shell,
            starting_directory,
            initial_command: _initial_command,
            ..ShellConfig::default()
        };

        let shell_cmd = build_shell_command(&config);

        info!(
            program = %shell_cmd.program,
            "Spawning local shell"
        );

        // Spawn PTY.
        let pty_system = native_pty_system();
        let pty_pair = pty_system
            .openpty(PtySize {
                rows: shell_cmd.rows,
                cols: shell_cmd.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| SessionError::SpawnFailed(e.to_string()))?;

        let mut command = CommandBuilder::new(&shell_cmd.program);
        for arg in &shell_cmd.args {
            command.arg(arg);
        }
        for (key, value) in &shell_cmd.env {
            command.env(key, value);
        }
        if let Some(ref cwd) = shell_cmd.cwd {
            command.cwd(cwd);
        }

        let child = pty_pair
            .slave
            .spawn_command(command)
            .map_err(|e| SessionError::SpawnFailed(e.to_string()))?;

        // Drop slave — we only need master.
        drop(pty_pair.slave);

        let writer = pty_pair
            .master
            .take_writer()
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
        let mut reader = pty_pair
            .master
            .try_clone_reader()
            .map_err(|e| SessionError::SpawnFailed(e.to_string()))?;

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
                                // Err means receiver dropped — subscriber replaced or
                                // disconnected. Continue so we pick up a new sender on
                                // the next iteration.
                                let _ = sender.blocking_send(data);
                            } else {
                                // No sender — disconnected.
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
            // Drop the sender so the output channel closes, signaling
            // consumers (e.g. the session daemon) that the shell exited.
            if let Ok(mut guard) = output_tx_clone.lock() {
                *guard = None;
            }
        });

        self.state = Some(ConnectedState {
            master: Arc::new(Mutex::new(pty_pair.master)),
            writer: Arc::new(Mutex::new(writer)),
            alive,
            child: Arc::new(Mutex::new(child)),
        });

        Ok(())
    }

    async fn disconnect(&mut self) -> Result<(), SessionError> {
        if let Some(state) = self.state.take() {
            state.alive.store(false, Ordering::SeqCst);
            if let Ok(mut child) = state.child.lock() {
                let _ = child.kill();
            }
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
        let master = state.master.lock().map_err(|e| {
            SessionError::Io(std::io::Error::other(format!("Failed to lock master: {e}")))
        })?;
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| SessionError::Io(std::io::Error::other(e.to_string())))?;
        Ok(())
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
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::validate_settings;

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
        assert!(!caps.file_browser);
        assert!(!caps.persistent);
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
            // Non-default shells should NOT have the suffix
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

    // -----------------------------------------------------------------------
    // Integration tests (spawn real shells)
    // -----------------------------------------------------------------------

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

        // Subscribe to output.
        let mut rx = shell.subscribe_output();

        // Write a command.
        shell.write(b"echo HELLO_TERMIHUB\n").expect("write failed");

        // Read output with timeout.
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

        // Resize should succeed.
        shell.resize(120, 40).expect("resize failed");

        // Disconnect.
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
        let mut rx2 = shell.subscribe_output(); // replaces rx1

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
        // Should not error.
        shell
            .disconnect()
            .await
            .expect("disconnect should not fail");
    }
}
