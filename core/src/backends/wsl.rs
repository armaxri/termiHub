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
use crate::errors::{FileError, SessionError};
use crate::files::{FileBrowser, FileEntry};
use crate::monitoring::MonitoringProvider;
use crate::session::shell::{detect_wsl_distros, osc7_setup_command, shell_to_command};

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
    /// File browser provider, created on connect.
    file_browser_provider: Option<WslFileBrowser>,
}

/// Internal state of an active WSL connection.
struct ConnectedState {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    alive: Arc<AtomicBool>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send>>>,
}

/// File browser for WSL distributions via `\\wsl$\<distro>\` UNC paths.
///
/// Accesses the WSL filesystem through Windows' built-in UNC path support,
/// which maps `\\wsl$\<distro>\<path>` to the distribution's root filesystem.
/// All paths presented to the user are Linux-style (e.g., `/home/user`);
/// UNC path translation is handled internally.
pub(crate) struct WslFileBrowser {
    distribution: String,
}

impl WslFileBrowser {
    pub(crate) fn new(distribution: String) -> Self {
        Self { distribution }
    }

    /// Convert a Linux path to a Windows UNC path for the WSL distribution.
    ///
    /// `/home/user` → `\\wsl$\Ubuntu\home\user`
    fn to_unc_path(&self, linux_path: &str) -> String {
        let win_path = linux_path.replace('/', "\\");
        format!("\\\\wsl$\\{}{}", self.distribution, win_path)
    }

    /// Build a Linux path from a parent directory and file name.
    ///
    /// Ensures a single `/` separator between parent and name.
    fn join_linux_path(parent: &str, name: &str) -> String {
        if parent.ends_with('/') {
            format!("{parent}{name}")
        } else {
            format!("{parent}/{name}")
        }
    }
}

/// Map `std::io::Error` to `FileError` based on error kind.
fn map_io_error(e: std::io::Error, path: &str) -> FileError {
    match e.kind() {
        std::io::ErrorKind::NotFound => FileError::NotFound(path.to_string()),
        std::io::ErrorKind::PermissionDenied => FileError::PermissionDenied(path.to_string()),
        _ => FileError::OperationFailed(format!("{path}: {e}")),
    }
}

/// Build a `FileEntry` from filesystem metadata.
fn entry_from_metadata(name: String, path: String, metadata: &std::fs::Metadata) -> FileEntry {
    use crate::files::utils::chrono_from_epoch;

    let modified = metadata
        .modified()
        .ok()
        .and_then(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|d| chrono_from_epoch(d.as_secs()))
        })
        .unwrap_or_default();

    FileEntry {
        name,
        path,
        is_directory: metadata.is_dir(),
        size: metadata.len(),
        modified,
        // Unix permissions are not available via UNC paths on Windows.
        permissions: None,
    }
}

#[async_trait::async_trait]
impl FileBrowser for WslFileBrowser {
    async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, FileError> {
        let unc_path = self.to_unc_path(path);
        let linux_parent = path.to_string();
        tokio::task::spawn_blocking(move || {
            let entries =
                std::fs::read_dir(&unc_path).map_err(|e| map_io_error(e, &linux_parent))?;

            let mut result = Vec::new();
            for entry in entries {
                let entry = entry.map_err(|e| map_io_error(e, &linux_parent))?;
                let name = entry.file_name().to_string_lossy().to_string();

                if name == "." || name == ".." {
                    continue;
                }

                let metadata = entry
                    .metadata()
                    .map_err(|e| map_io_error(e, &linux_parent))?;
                let full_path = WslFileBrowser::join_linux_path(&linux_parent, &name);
                result.push(entry_from_metadata(name, full_path, &metadata));
            }

            result.sort_by(|a, b| {
                b.is_directory
                    .cmp(&a.is_directory)
                    .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            });

            Ok(result)
        })
        .await
        .map_err(|e| FileError::OperationFailed(e.to_string()))?
    }

    async fn read_file(&self, path: &str) -> Result<Vec<u8>, FileError> {
        let unc_path = self.to_unc_path(path);
        let linux_path = path.to_string();
        tokio::task::spawn_blocking(move || {
            std::fs::read(&unc_path).map_err(|e| map_io_error(e, &linux_path))
        })
        .await
        .map_err(|e| FileError::OperationFailed(e.to_string()))?
    }

    async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), FileError> {
        let unc_path = self.to_unc_path(path);
        let linux_path = path.to_string();
        let data = data.to_vec();
        tokio::task::spawn_blocking(move || {
            std::fs::write(&unc_path, &data).map_err(|e| map_io_error(e, &linux_path))
        })
        .await
        .map_err(|e| FileError::OperationFailed(e.to_string()))?
    }

    async fn delete(&self, path: &str) -> Result<(), FileError> {
        let unc_path = self.to_unc_path(path);
        let linux_path = path.to_string();
        tokio::task::spawn_blocking(move || {
            let metadata =
                std::fs::metadata(&unc_path).map_err(|e| map_io_error(e, &linux_path))?;
            if metadata.is_dir() {
                std::fs::remove_dir_all(&unc_path).map_err(|e| map_io_error(e, &linux_path))
            } else {
                std::fs::remove_file(&unc_path).map_err(|e| map_io_error(e, &linux_path))
            }
        })
        .await
        .map_err(|e| FileError::OperationFailed(e.to_string()))?
    }

    async fn rename(&self, from: &str, to: &str) -> Result<(), FileError> {
        let unc_from = self.to_unc_path(from);
        let unc_to = self.to_unc_path(to);
        let linux_from = from.to_string();
        tokio::task::spawn_blocking(move || {
            std::fs::rename(&unc_from, &unc_to).map_err(|e| map_io_error(e, &linux_from))
        })
        .await
        .map_err(|e| FileError::OperationFailed(e.to_string()))?
    }

    async fn stat(&self, path: &str) -> Result<FileEntry, FileError> {
        let unc_path = self.to_unc_path(path);
        let linux_path = path.to_string();
        tokio::task::spawn_blocking(move || {
            let metadata =
                std::fs::metadata(&unc_path).map_err(|e| map_io_error(e, &linux_path))?;
            let name = std::path::Path::new(&linux_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| linux_path.clone());
            Ok(entry_from_metadata(name, linux_path, &metadata))
        })
        .await
        .map_err(|e| FileError::OperationFailed(e.to_string()))?
    }

    async fn mkdir(&self, path: &str) -> Result<(), FileError> {
        let unc_path = self.to_unc_path(path);
        let linux_path = path.to_string();
        tokio::task::spawn_blocking(move || {
            std::fs::create_dir_all(&unc_path).map_err(|e| map_io_error(e, &linux_path))
        })
        .await
        .map_err(|e| FileError::OperationFailed(e.to_string()))?
    }
}

impl Wsl {
    /// Create a new disconnected `Wsl` instance.
    pub fn new() -> Self {
        Self {
            state: None,
            output_tx: Arc::new(Mutex::new(None)),
            file_browser_provider: None,
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

        self.file_browser_provider = Some(WslFileBrowser::new(distribution));

        // Inject OSC 7 PROMPT_COMMAND hook for CWD tracking.
        // The setup command configures bash/zsh to emit OSC 7 on each prompt,
        // allowing the file browser to follow the terminal's working directory.
        // Errors are non-fatal — the shell works without CWD tracking.
        if let Some(setup) = osc7_setup_command(&shell_key) {
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
            if let Ok(mut child) = state.child.lock() {
                let _ = child.kill();
            }
            // Clear the sender to signal the reader thread to stop.
            if let Ok(mut guard) = self.output_tx.lock() {
                *guard = None;
            }
            self.file_browser_provider = None;
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
        self.file_browser_provider
            .as_ref()
            .map(|p| p as &dyn FileBrowser)
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

    #[test]
    fn file_browser_none_when_disconnected() {
        let wsl = Wsl::new();
        assert!(wsl.file_browser().is_none());
    }

    // -----------------------------------------------------------------------
    // WslFileBrowser unit tests
    // -----------------------------------------------------------------------

    #[test]
    fn to_unc_path_root() {
        let browser = WslFileBrowser::new("Ubuntu".to_string());
        assert_eq!(browser.to_unc_path("/"), r"\\wsl$\Ubuntu\");
    }

    #[test]
    fn to_unc_path_home() {
        let browser = WslFileBrowser::new("Ubuntu".to_string());
        assert_eq!(
            browser.to_unc_path("/home/user"),
            r"\\wsl$\Ubuntu\home\user"
        );
    }

    #[test]
    fn to_unc_path_nested() {
        let browser = WslFileBrowser::new("Debian".to_string());
        assert_eq!(
            browser.to_unc_path("/var/log/syslog"),
            r"\\wsl$\Debian\var\log\syslog"
        );
    }

    #[test]
    fn to_unc_path_distro_with_spaces() {
        let browser = WslFileBrowser::new("Ubuntu 22.04".to_string());
        assert_eq!(browser.to_unc_path("/home"), r"\\wsl$\Ubuntu 22.04\home");
    }

    #[test]
    fn join_linux_path_no_trailing_slash() {
        assert_eq!(
            WslFileBrowser::join_linux_path("/home/user", "file.txt"),
            "/home/user/file.txt"
        );
    }

    #[test]
    fn join_linux_path_with_trailing_slash() {
        assert_eq!(
            WslFileBrowser::join_linux_path("/home/user/", "file.txt"),
            "/home/user/file.txt"
        );
    }

    #[test]
    fn join_linux_path_root() {
        assert_eq!(WslFileBrowser::join_linux_path("/", "etc"), "/etc");
    }

    #[test]
    fn map_io_error_not_found() {
        let err = super::map_io_error(
            std::io::Error::new(std::io::ErrorKind::NotFound, "gone"),
            "/home/user/missing",
        );
        assert!(matches!(err, FileError::NotFound(_)));
    }

    #[test]
    fn map_io_error_permission_denied() {
        let err = super::map_io_error(
            std::io::Error::new(std::io::ErrorKind::PermissionDenied, "nope"),
            "/root/secret",
        );
        assert!(matches!(err, FileError::PermissionDenied(_)));
    }

    #[test]
    fn map_io_error_other() {
        let err = super::map_io_error(std::io::Error::other("boom"), "/some/path");
        assert!(matches!(err, FileError::OperationFailed(_)));
    }

    #[test]
    fn entry_from_metadata_builds_correct_entry() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("test.txt");
        std::fs::write(&file_path, "hello").unwrap();

        let metadata = std::fs::metadata(&file_path).unwrap();
        let entry = super::entry_from_metadata(
            "test.txt".to_string(),
            "/home/user/test.txt".to_string(),
            &metadata,
        );

        assert_eq!(entry.name, "test.txt");
        assert_eq!(entry.path, "/home/user/test.txt");
        assert!(!entry.is_directory);
        assert_eq!(entry.size, 5);
        assert!(!entry.modified.is_empty());
        // Permissions are None (UNC paths don't expose Unix permissions)
        assert!(entry.permissions.is_none());
    }

    #[test]
    fn entry_from_metadata_directory() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("subdir");
        std::fs::create_dir(&sub).unwrap();

        let metadata = std::fs::metadata(&sub).unwrap();
        let entry = super::entry_from_metadata(
            "subdir".to_string(),
            "/home/user/subdir".to_string(),
            &metadata,
        );

        assert_eq!(entry.name, "subdir");
        assert!(entry.is_directory);
    }

    // -----------------------------------------------------------------------
    // WslFileBrowser async tests (using tempdir as filesystem stand-in)
    //
    // These tests exercise the FileBrowser trait implementation by creating
    // a WslFileBrowser that points to a tempdir via a synthetic UNC prefix.
    // On non-Windows platforms, the UNC paths won't resolve, so these tests
    // are Windows-only. However, the path conversion and helper logic is
    // tested cross-platform above.
    // -----------------------------------------------------------------------

    #[cfg(windows)]
    mod file_browser_integration {
        use super::super::*;
        use crate::files::FileBrowser;

        /// Helper to create a WslFileBrowser that uses a real WSL distribution.
        /// Returns `None` if no WSL distributions are installed.
        fn create_test_browser() -> Option<WslFileBrowser> {
            let wsl = Wsl::new();
            let schema = wsl.settings_schema();
            let distro_field = schema.groups[0]
                .fields
                .iter()
                .find(|f| f.key == "distribution")
                .unwrap();

            if let FieldType::Select { options } = &distro_field.field_type {
                options
                    .first()
                    .map(|o| WslFileBrowser::new(o.value.clone()))
            } else {
                None
            }
        }

        #[tokio::test]
        async fn list_dir_root() {
            let Some(browser) = create_test_browser() else {
                eprintln!("No WSL distributions — skipping");
                return;
            };

            let entries = browser.list_dir("/").await;
            assert!(entries.is_ok(), "list_dir('/') failed: {entries:?}");
            let entries = entries.unwrap();
            // Root should have common directories like etc, home, usr
            assert!(
                entries.iter().any(|e| e.name == "etc"),
                "expected 'etc' in root listing"
            );
        }

        #[tokio::test]
        async fn stat_root() {
            let Some(browser) = create_test_browser() else {
                eprintln!("No WSL distributions — skipping");
                return;
            };

            let stat = browser.stat("/").await;
            assert!(stat.is_ok(), "stat('/') failed: {stat:?}");
            let stat = stat.unwrap();
            assert!(stat.is_directory);
        }

        #[tokio::test]
        async fn read_write_delete_round_trip() {
            let Some(browser) = create_test_browser() else {
                eprintln!("No WSL distributions — skipping");
                return;
            };

            let test_path = "/tmp/termihub_wsl_test_484.txt";
            let data = b"hello from WSL file browser test";

            // Write
            browser
                .write_file(test_path, data)
                .await
                .expect("write_file failed");

            // Read back
            let read_data = browser
                .read_file(test_path)
                .await
                .expect("read_file failed");
            assert_eq!(read_data, data);

            // Stat
            let stat = browser.stat(test_path).await.expect("stat failed");
            assert_eq!(stat.name, "termihub_wsl_test_484.txt");
            assert!(!stat.is_directory);
            assert_eq!(stat.size, data.len() as u64);

            // Delete
            browser.delete(test_path).await.expect("delete failed");

            // Verify deleted
            let result = browser.stat(test_path).await;
            assert!(result.is_err());
        }

        #[tokio::test]
        async fn rename_file() {
            let Some(browser) = create_test_browser() else {
                eprintln!("No WSL distributions — skipping");
                return;
            };

            let from = "/tmp/termihub_wsl_rename_from_484.txt";
            let to = "/tmp/termihub_wsl_rename_to_484.txt";

            browser
                .write_file(from, b"rename test")
                .await
                .expect("write failed");

            browser.rename(from, to).await.expect("rename failed");

            // Original should be gone
            assert!(browser.stat(from).await.is_err());

            // New path should exist
            let data = browser.read_file(to).await.expect("read failed");
            assert_eq!(data, b"rename test");

            // Cleanup
            browser.delete(to).await.ok();
        }

        #[tokio::test]
        async fn list_dir_nonexistent_returns_error() {
            let Some(browser) = create_test_browser() else {
                eprintln!("No WSL distributions — skipping");
                return;
            };

            let result = browser.list_dir("/nonexistent_dir_termihub_484").await;
            assert!(result.is_err());
        }

        #[tokio::test]
        async fn read_nonexistent_returns_error() {
            let Some(browser) = create_test_browser() else {
                eprintln!("No WSL distributions — skipping");
                return;
            };

            let result = browser
                .read_file("/nonexistent_file_termihub_484.txt")
                .await;
            assert!(result.is_err());
        }

        #[tokio::test]
        async fn list_dir_returns_linux_paths() {
            let Some(browser) = create_test_browser() else {
                eprintln!("No WSL distributions — skipping");
                return;
            };

            let entries = browser.list_dir("/").await.expect("list_dir failed");
            for entry in &entries {
                assert!(
                    entry.path.starts_with('/'),
                    "expected Linux path starting with '/', got: {}",
                    entry.path
                );
                assert!(
                    !entry.path.contains('\\'),
                    "path should not contain backslashes: {}",
                    entry.path
                );
            }
        }

        #[tokio::test]
        async fn list_dir_sorts_directories_first() {
            let Some(browser) = create_test_browser() else {
                eprintln!("No WSL distributions — skipping");
                return;
            };

            let entries = browser.list_dir("/").await.expect("list_dir failed");
            // Find the transition point from directories to files
            let mut seen_file = false;
            for entry in &entries {
                if !entry.is_directory {
                    seen_file = true;
                } else if seen_file {
                    panic!(
                        "directory '{}' appeared after a file in sorted listing",
                        entry.name
                    );
                }
            }
        }
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

    /// Regression test for #408: verify the OSC 7 PROMPT_COMMAND hook is
    /// injected into WSL sessions by checking for the `__termihub_osc7`
    /// function definition in the echoed output.
    #[cfg(windows)]
    #[tokio::test]
    async fn osc7_setup_injected_for_wsl() {
        let wsl_instance = Wsl::new();
        let schema = wsl_instance.settings_schema();
        let distro_field = schema.groups[0]
            .fields
            .iter()
            .find(|f| f.key == "distribution")
            .unwrap();

        let distro = if let FieldType::Select { options } = &distro_field.field_type {
            if options.is_empty() {
                eprintln!("No WSL distributions installed — skipping OSC 7 injection test");
                return;
            }
            options[0].value.clone()
        } else {
            panic!("expected Select field type for distribution");
        };

        let mut wsl = Wsl::new();
        let settings = serde_json::json!({ "distribution": distro });

        wsl.connect(settings).await.expect("connect failed");
        let mut rx = wsl.subscribe_output();

        // Wait for the setup command to be echoed back by the PTY.
        // The echo contains the __termihub_osc7 function and PROMPT_COMMAND.
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
            "expected OSC 7 setup (__termihub_osc7 + PROMPT_COMMAND) in WSL output, got: {:?}",
            String::from_utf8_lossy(&output)
        );

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
