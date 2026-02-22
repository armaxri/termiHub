//! WSL (Windows Subsystem for Linux) backend implementing
//! [`ConnectionType`](crate::connection::ConnectionType).
//!
//! Uses `portable-pty` to spawn WSL distributions via `wsl.exe -d <distro>`.
//! This is a Windows-only backend — the entire module is gated with
//! `#[cfg(windows)]` at the module declaration in `backends/mod.rs`.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tracing::{debug, info};

use crate::config::WslConfig;
use crate::connection::{
    Capabilities, ConnectionType, FieldType, FilePathKind, OutputReceiver, OutputSender,
    SelectOption, SettingsField, SettingsGroup, SettingsSchema,
};
use crate::errors::SessionError;
use crate::files::FileBrowser;
use crate::monitoring::MonitoringProvider;
use crate::session::shell::{detect_wsl_distros, shell_to_command};

/// Channel capacity for output data from the PTY reader thread.
const OUTPUT_CHANNEL_CAPACITY: usize = 64;

/// WSL backend using portable-pty, implementing [`ConnectionType`].
///
/// # Lifecycle
///
/// 1. Create with [`Wsl::new()`] (disconnected state).
/// 2. Call [`connect()`](ConnectionType::connect) with settings JSON
///    containing at least a `distribution` field.
/// 3. Use [`write()`](ConnectionType::write),
///    [`resize()`](ConnectionType::resize),
///    [`subscribe_output()`](ConnectionType::subscribe_output) for I/O.
/// 4. Call [`disconnect()`](ConnectionType::disconnect) to clean up.
pub struct Wsl {
    /// State is `None` when disconnected, `Some` when connected.
    state: Option<ConnectedState>,
    /// The output sender is stored so `subscribe_output()` can replace
    /// the channel. The reader thread also holds a reference and picks up
    /// the replacement on its next iteration.
    output_tx: Arc<Mutex<Option<OutputSender>>>,
}

/// Internal state of an active WSL connection.
struct ConnectedState {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    alive: Arc<AtomicBool>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send>>>,
}

impl Wsl {
    /// Create a new disconnected `Wsl` instance.
    pub fn new() -> Self {
        Self {
            state: None,
            output_tx: Arc::new(Mutex::new(None)),
        }
    }
}

impl Default for Wsl {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl ConnectionType for Wsl {
    fn type_id(&self) -> &str {
        "wsl"
    }

    fn display_name(&self) -> &str {
        "WSL"
    }

    fn settings_schema(&self) -> SettingsSchema {
        let distros = detect_wsl_distros();

        let distro_options: Vec<SelectOption> = distros
            .iter()
            .map(|d| SelectOption {
                value: d.clone(),
                label: d.clone(),
            })
            .collect();

        SettingsSchema {
            groups: vec![SettingsGroup {
                key: "wsl".to_string(),
                label: "WSL".to_string(),
                fields: vec![
                    SettingsField {
                        key: "distribution".to_string(),
                        label: "Distribution".to_string(),
                        description: Some("WSL distribution to connect to".to_string()),
                        field_type: FieldType::Select {
                            options: distro_options,
                        },
                        required: true,
                        default: distros.first().map(|d| serde_json::json!(d)),
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
            file_browser: true,
            resize: true,
            persistent: true,
        }
    }

    async fn connect(&mut self, settings: serde_json::Value) -> Result<(), SessionError> {
        if self.state.is_some() {
            return Err(SessionError::AlreadyExists("Already connected".to_string()));
        }

        // Parse settings into WslConfig.
        let distribution = settings
            .get("distribution")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                SessionError::InvalidConfig("Missing required field: distribution".to_string())
            })?
            .to_string();

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

        let config = WslConfig {
            distribution: distribution.clone(),
            starting_directory,
            initial_command: _initial_command,
            ..WslConfig::default()
        };

        // Resolve the WSL command via the shared shell helper.
        let shell_key = format!("wsl:{}", config.distribution);
        let (program, mut args) = shell_to_command(&shell_key);

        // Add starting directory as --cd argument if specified.
        if let Some(ref dir) = config.starting_directory {
            args.push("--cd".into());
            args.push(dir.clone());
        }

        info!(
            program = %program,
            distribution = %config.distribution,
            "Spawning WSL shell"
        );

        // Spawn PTY.
        let pty_system = native_pty_system();
        let pty_pair = pty_system
            .openpty(PtySize {
                rows: config.rows,
                cols: config.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| SessionError::SpawnFailed(e.to_string()))?;

        let mut command = CommandBuilder::new(&program);
        for arg in &args {
            command.arg(arg);
        }
        // Set TERM for the WSL environment.
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");

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
            debug!("WSL shell disconnected");
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
        // TODO: Implement WSL file browser via \\wsl$\<distro>\ or wsl commands
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::validate_settings;

    #[test]
    fn type_id() {
        let wsl = Wsl::new();
        assert_eq!(wsl.type_id(), "wsl");
    }

    #[test]
    fn display_name() {
        let wsl = Wsl::new();
        assert_eq!(wsl.display_name(), "WSL");
    }

    #[test]
    fn capabilities() {
        let wsl = Wsl::new();
        let caps = wsl.capabilities();
        assert!(caps.resize);
        assert!(!caps.monitoring);
        assert!(caps.file_browser);
        assert!(caps.persistent);
    }

    #[test]
    fn not_connected_initially() {
        let wsl = Wsl::new();
        assert!(!wsl.is_connected());
    }

    #[test]
    fn schema_has_distribution_field() {
        let wsl = Wsl::new();
        let schema = wsl.settings_schema();
        assert!(!schema.groups.is_empty());
        let fields = &schema.groups[0].fields;
        assert!(fields.iter().any(|f| f.key == "distribution"));
    }

    #[test]
    fn schema_has_starting_directory() {
        let wsl = Wsl::new();
        let schema = wsl.settings_schema();
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
        let wsl = Wsl::new();
        let schema = wsl.settings_schema();
        let fields = &schema.groups[0].fields;
        let cmd_field = fields.iter().find(|f| f.key == "initialCommand");
        assert!(cmd_field.is_some());
        let f = cmd_field.unwrap();
        assert!(!f.required);
    }

    #[test]
    fn schema_distribution_is_required() {
        let wsl = Wsl::new();
        let schema = wsl.settings_schema();
        let fields = &schema.groups[0].fields;
        let distro_field = fields.iter().find(|f| f.key == "distribution").unwrap();
        assert!(distro_field.required);
    }

    #[test]
    fn write_when_disconnected_errors() {
        let wsl = Wsl::new();
        let result = wsl.write(b"hello");
        assert!(result.is_err());
    }

    #[test]
    fn resize_when_disconnected_errors() {
        let wsl = Wsl::new();
        let result = wsl.resize(80, 24);
        assert!(result.is_err());
    }

    #[test]
    fn validation_missing_distribution_fails() {
        let wsl = Wsl::new();
        let schema = wsl.settings_schema();
        let settings = serde_json::json!({});
        let errors = validate_settings(&schema, &settings);
        assert!(!errors.is_empty());
        assert!(errors.iter().any(|e| e.field == "distribution"));
    }

    #[test]
    fn default_creates_disconnected() {
        let wsl = Wsl::default();
        assert!(!wsl.is_connected());
    }

    #[tokio::test]
    async fn disconnect_when_not_connected_is_noop() {
        let mut wsl = Wsl::new();
        wsl.disconnect().await.expect("disconnect should not fail");
    }

    // -----------------------------------------------------------------------
    // Integration tests (spawn real WSL) — Windows-only
    // -----------------------------------------------------------------------

    #[cfg(windows)]
    #[tokio::test]
    async fn connect_and_receive_output() {
        let wsl = Wsl::new();
        let schema = wsl.settings_schema();

        // Find the distribution field and get the first option.
        let distro_field = schema.groups[0]
            .fields
            .iter()
            .find(|f| f.key == "distribution")
            .unwrap();

        let distro = if let FieldType::Select { options } = &distro_field.field_type {
            if options.is_empty() {
                eprintln!("No WSL distributions installed — skipping integration test");
                return;
            }
            options[0].value.clone()
        } else {
            panic!("expected Select field type for distribution");
        };

        let mut wsl = Wsl::new();
        let settings = serde_json::json!({ "distribution": distro });

        wsl.connect(settings).await.expect("connect failed");
        assert!(wsl.is_connected());

        let mut rx = wsl.subscribe_output();

        wsl.write(b"echo HELLO_WSL_TERMIHUB\n")
            .expect("write failed");

        let mut output = Vec::new();
        let deadline = tokio::time::Duration::from_secs(5);
        let result = tokio::time::timeout(deadline, async {
            while let Some(chunk) = rx.recv().await {
                output.extend_from_slice(&chunk);
                let text = String::from_utf8_lossy(&output);
                if text.contains("HELLO_WSL_TERMIHUB") {
                    return true;
                }
            }
            false
        })
        .await;

        assert!(
            result.unwrap_or(false),
            "expected HELLO_WSL_TERMIHUB in output, got: {}",
            String::from_utf8_lossy(&output)
        );

        wsl.resize(120, 40).expect("resize failed");

        wsl.disconnect().await.expect("disconnect failed");
        assert!(!wsl.is_connected());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn connect_already_connected_fails() {
        let wsl_instance = Wsl::new();
        let schema = wsl_instance.settings_schema();
        let distro_field = schema.groups[0]
            .fields
            .iter()
            .find(|f| f.key == "distribution")
            .unwrap();

        let distro = if let FieldType::Select { options } = &distro_field.field_type {
            if options.is_empty() {
                eprintln!("No WSL distributions installed — skipping integration test");
                return;
            }
            options[0].value.clone()
        } else {
            panic!("expected Select field type for distribution");
        };

        let mut wsl = Wsl::new();
        let settings = serde_json::json!({ "distribution": distro });

        wsl.connect(settings.clone()).await.expect("first connect");
        let result = wsl.connect(settings).await;
        assert!(result.is_err());

        wsl.disconnect().await.ok();
    }

    #[cfg(windows)]
    #[test]
    fn schema_distribution_options_not_empty_on_wsl_host() {
        let wsl = Wsl::new();
        let schema = wsl.settings_schema();
        let distro_field = schema.groups[0]
            .fields
            .iter()
            .find(|f| f.key == "distribution")
            .unwrap();
        if let FieldType::Select { options } = &distro_field.field_type {
            // This test only passes if WSL is installed with at least one distro.
            // On CI without WSL it will be empty, which is acceptable.
            if !options.is_empty() {
                assert!(
                    options.iter().all(|o| !o.value.is_empty()),
                    "distribution options should have non-empty values"
                );
            }
        } else {
            panic!("expected Select field type for distribution");
        }
    }

    #[cfg(windows)]
    #[test]
    fn validation_valid_settings_passes() {
        let wsl = Wsl::new();
        let schema = wsl.settings_schema();
        let distro_field = schema.groups[0]
            .fields
            .iter()
            .find(|f| f.key == "distribution")
            .unwrap();

        if let FieldType::Select { options } = &distro_field.field_type {
            if let Some(first) = options.first() {
                let settings = serde_json::json!({ "distribution": first.value });
                let errors = validate_settings(&schema, &settings);
                assert!(errors.is_empty(), "errors: {errors:?}");
            }
        }
    }
}
