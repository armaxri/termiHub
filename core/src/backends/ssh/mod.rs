//! SSH backend implementing [`ConnectionType`](crate::connection::ConnectionType).
//!
//! Provides terminal I/O over SSH with optional monitoring (via SSH exec)
//! and file browsing (SFTP). This is the canonical SSH implementation,
//! used by both the desktop and agent crates.

pub mod auth;
mod file_browser;
mod monitoring;
pub mod x11;

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tracing::{debug, info, warn};

use crate::config::SshConfig;
use crate::connection::{
    Capabilities, Condition, ConnectionType, FieldType, FilePathKind, OutputReceiver, OutputSender,
    SelectOption, SettingsField, SettingsGroup, SettingsSchema,
};
use crate::errors::SessionError;
use crate::files::FileBrowser;
use crate::monitoring::MonitoringProvider;
use crate::session::ssh::validate_ssh_config;

use self::auth::connect_and_authenticate;
use self::file_browser::SftpFileBrowser;
use self::monitoring::SshMonitoringProvider;
use self::x11::X11Forwarder;

/// Channel capacity for output data from the SSH reader thread.
const OUTPUT_CHANNEL_CAPACITY: usize = 64;

/// SSH backend using `ssh2`, implementing [`ConnectionType`].
///
/// # Lifecycle
///
/// 1. Create with [`Ssh::new()`] (disconnected state).
/// 2. Call [`connect()`](ConnectionType::connect) with settings JSON.
/// 3. Use [`write()`](ConnectionType::write),
///    [`subscribe_output()`](ConnectionType::subscribe_output) for I/O.
/// 4. Optional: [`monitoring()`](ConnectionType::monitoring),
///    [`file_browser()`](ConnectionType::file_browser).
/// 5. Call [`disconnect()`](ConnectionType::disconnect) to clean up.
pub struct Ssh {
    /// State is `None` when disconnected, `Some` when connected.
    state: Option<ConnectedState>,
    /// The output sender is stored so `subscribe_output()` can replace
    /// the channel. The reader thread also holds a reference and picks up
    /// the replacement on its next iteration.
    output_tx: Arc<Mutex<Option<OutputSender>>>,
    /// Monitoring provider, created on connect.
    monitoring_provider: Option<SshMonitoringProvider>,
    /// File browser provider (SFTP), created on connect.
    file_browser_provider: Option<SftpFileBrowser>,
}

/// Internal state of an active SSH connection.
struct ConnectedState {
    session: Arc<ssh2::Session>,
    channel: Arc<Mutex<ssh2::Channel>>,
    alive: Arc<AtomicBool>,
    _x11_forwarder: Option<X11Forwarder>,
}

impl Ssh {
    /// Create a new disconnected `Ssh` instance.
    pub fn new() -> Self {
        Self {
            state: None,
            output_tx: Arc::new(Mutex::new(None)),
            monitoring_provider: None,
            file_browser_provider: None,
        }
    }
}

impl Default for Ssh {
    fn default() -> Self {
        Self::new()
    }
}

/// Parse settings JSON into an `SshConfig`.
fn parse_ssh_settings(settings: &serde_json::Value) -> SshConfig {
    let str_field = |key: &str| -> String {
        settings
            .get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let opt_str = |key: &str| -> Option<String> {
        settings
            .get(key)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    };
    let bool_field = |key: &str, default: bool| -> bool {
        settings
            .get(key)
            .and_then(|v| v.as_bool())
            .unwrap_or(default)
    };
    let opt_bool = |key: &str| -> Option<bool> { settings.get(key).and_then(|v| v.as_bool()) };

    let port: u16 = settings
        .get("port")
        .and_then(|v| {
            v.as_u64()
                .map(|n| n as u16)
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        })
        .unwrap_or(22);

    let env = settings
        .get("env")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    let k = item.get("key").and_then(|v| v.as_str())?;
                    let v = item.get("value").and_then(|v| v.as_str())?;
                    Some((k.to_string(), v.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();

    SshConfig {
        host: str_field("host"),
        port,
        username: str_field("username"),
        auth_method: str_field("authMethod"),
        password: opt_str("password"),
        key_path: opt_str("keyPath"),
        shell: opt_str("shell"),
        cols: 80,
        rows: 24,
        env,
        enable_x11_forwarding: bool_field("enableX11Forwarding", false),
        enable_monitoring: opt_bool("enableMonitoring"),
        enable_file_browser: opt_bool("enableFileBrowser"),
        save_password: opt_bool("savePassword"),
    }
}

#[async_trait::async_trait]
impl ConnectionType for Ssh {
    fn type_id(&self) -> &str {
        "ssh"
    }

    fn display_name(&self) -> &str {
        "SSH"
    }

    fn settings_schema(&self) -> SettingsSchema {
        SettingsSchema {
            groups: vec![
                SettingsGroup {
                    key: "connection".to_string(),
                    label: "Connection".to_string(),
                    fields: vec![
                        SettingsField {
                            key: "host".to_string(),
                            label: "Host".to_string(),
                            description: Some(
                                "Hostname or IP address of the SSH server".to_string(),
                            ),
                            field_type: FieldType::Text,
                            required: true,
                            default: None,
                            placeholder: Some("example.com".to_string()),
                            supports_env_expansion: true,
                            supports_tilde_expansion: false,
                            visible_when: None,
                        },
                        SettingsField {
                            key: "port".to_string(),
                            label: "Port".to_string(),
                            description: Some("SSH port number".to_string()),
                            field_type: FieldType::Port,
                            required: true,
                            default: Some(serde_json::json!(22)),
                            placeholder: None,
                            supports_env_expansion: false,
                            supports_tilde_expansion: false,
                            visible_when: None,
                        },
                        SettingsField {
                            key: "username".to_string(),
                            label: "Username".to_string(),
                            description: Some("SSH login username".to_string()),
                            field_type: FieldType::Text,
                            required: true,
                            default: None,
                            placeholder: Some("root".to_string()),
                            supports_env_expansion: true,
                            supports_tilde_expansion: false,
                            visible_when: None,
                        },
                    ],
                },
                SettingsGroup {
                    key: "authentication".to_string(),
                    label: "Authentication".to_string(),
                    fields: vec![
                        SettingsField {
                            key: "authMethod".to_string(),
                            label: "Method".to_string(),
                            description: Some("Authentication method to use".to_string()),
                            field_type: FieldType::Select {
                                options: vec![
                                    SelectOption {
                                        value: "key".to_string(),
                                        label: "SSH Key".to_string(),
                                    },
                                    SelectOption {
                                        value: "password".to_string(),
                                        label: "Password".to_string(),
                                    },
                                    SelectOption {
                                        value: "agent".to_string(),
                                        label: "SSH Agent".to_string(),
                                    },
                                ],
                            },
                            required: true,
                            default: Some(serde_json::json!("key")),
                            placeholder: None,
                            supports_env_expansion: false,
                            supports_tilde_expansion: false,
                            visible_when: None,
                        },
                        SettingsField {
                            key: "password".to_string(),
                            label: "Password".to_string(),
                            description: None,
                            field_type: FieldType::Password,
                            required: false,
                            default: None,
                            placeholder: None,
                            supports_env_expansion: true,
                            supports_tilde_expansion: false,
                            visible_when: Some(Condition {
                                field: "authMethod".to_string(),
                                equals: serde_json::json!("password"),
                            }),
                        },
                        SettingsField {
                            key: "keyPath".to_string(),
                            label: "Key Path".to_string(),
                            description: Some("Path to SSH private key file".to_string()),
                            field_type: FieldType::FilePath {
                                kind: FilePathKind::File,
                            },
                            required: false,
                            default: None,
                            placeholder: Some("~/.ssh/id_rsa".to_string()),
                            supports_env_expansion: true,
                            supports_tilde_expansion: true,
                            visible_when: Some(Condition {
                                field: "authMethod".to_string(),
                                equals: serde_json::json!("key"),
                            }),
                        },
                        SettingsField {
                            key: "savePassword".to_string(),
                            label: "Save credentials".to_string(),
                            description: Some(
                                "Store credentials in the system keychain".to_string(),
                            ),
                            field_type: FieldType::Boolean,
                            required: false,
                            default: Some(serde_json::json!(false)),
                            placeholder: None,
                            supports_env_expansion: false,
                            supports_tilde_expansion: false,
                            visible_when: None,
                        },
                    ],
                },
                SettingsGroup {
                    key: "advanced".to_string(),
                    label: "Advanced".to_string(),
                    fields: vec![
                        SettingsField {
                            key: "shell".to_string(),
                            label: "Shell".to_string(),
                            description: Some(
                                "Remote shell to use (leave empty for default)".to_string(),
                            ),
                            field_type: FieldType::Text,
                            required: false,
                            default: None,
                            placeholder: Some("/bin/bash".to_string()),
                            supports_env_expansion: false,
                            supports_tilde_expansion: false,
                            visible_when: None,
                        },
                        SettingsField {
                            key: "enableX11Forwarding".to_string(),
                            label: "X11 Forwarding".to_string(),
                            description: Some(
                                "Forward X11 display from remote to local".to_string(),
                            ),
                            field_type: FieldType::Boolean,
                            required: false,
                            default: Some(serde_json::json!(false)),
                            placeholder: None,
                            supports_env_expansion: false,
                            supports_tilde_expansion: false,
                            visible_when: None,
                        },
                        SettingsField {
                            key: "env".to_string(),
                            label: "Environment Variables".to_string(),
                            description: Some(
                                "Additional environment variables for the remote shell"
                                    .to_string(),
                            ),
                            field_type: FieldType::KeyValueList,
                            required: false,
                            default: None,
                            placeholder: None,
                            supports_env_expansion: true,
                            supports_tilde_expansion: false,
                            visible_when: None,
                        },
                    ],
                },
            ],
        }
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            monitoring: true,
            file_browser: true,
            resize: true,
            persistent: true,
        }
    }

    async fn connect(&mut self, settings: serde_json::Value) -> Result<(), SessionError> {
        if self.state.is_some() {
            return Err(SessionError::AlreadyExists("Already connected".to_string()));
        }

        let config = parse_ssh_settings(&settings);
        let config = config.expand();

        validate_ssh_config(&config)?;

        info!(
            host = %config.host,
            port = config.port,
            user = %config.username,
            "Connecting SSH session"
        );

        let session = connect_and_authenticate(&config)?;

        let alive = Arc::new(AtomicBool::new(true));

        // Start X11 forwarding if enabled (before opening the shell channel).
        let (x11_forwarder, x11_display, x11_cookie) = if config.enable_x11_forwarding {
            match X11Forwarder::start(&config, alive.clone()) {
                Ok((forwarder, display_num, cookie)) => {
                    (Some(forwarder), Some(display_num), cookie)
                }
                Err(e) => {
                    warn!("X11 forwarding setup failed, continuing without it: {}", e);
                    (None, None, None)
                }
            }
        } else {
            (None, None, None)
        };

        debug!("Opening SSH shell channel");
        let mut channel = session
            .channel_session()
            .map_err(|e| SessionError::SpawnFailed(format!("Channel open failed: {e}")))?;

        // Try to set DISPLAY via setenv before PTY/shell.
        let mut display_set_via_env = false;
        if let Some(display_num) = x11_display {
            let display_val = format!("localhost:{display_num}.0");
            if channel.setenv("DISPLAY", &display_val).is_ok() {
                display_set_via_env = true;
            }
        }

        // Set user-specified environment variables.
        for (key, value) in &config.env {
            let _ = channel.setenv(key, value);
        }

        channel
            .request_pty("xterm-256color", None, Some((config.cols as u32, config.rows as u32, 0, 0)))
            .map_err(|e| SessionError::SpawnFailed(format!("PTY request failed: {e}")))?;

        channel
            .shell()
            .map_err(|e| SessionError::SpawnFailed(format!("Shell request failed: {e}")))?;

        // If setenv failed (most servers reject it), inject export DISPLAY after shell starts.
        if let Some(display_num) = x11_display {
            if !display_set_via_env {
                let display_cmd = format!("export DISPLAY=localhost:{display_num}.0\n");
                let _ = channel.write_all(display_cmd.as_bytes());
            }
            if let Some(ref cookie) = x11_cookie {
                let xauth_cmd = format!(
                    "xauth add localhost:{display_num} MIT-MAGIC-COOKIE-1 {cookie} 2>/dev/null\n",
                );
                let _ = channel.write_all(xauth_cmd.as_bytes());
            }
        }

        // Set non-blocking for reading.
        session.set_blocking(false);

        let channel = Arc::new(Mutex::new(channel));
        let session = Arc::new(session);

        // Set up output channel.
        let (tx, _rx) = tokio::sync::mpsc::channel(OUTPUT_CHANNEL_CAPACITY);
        {
            let mut guard = self.output_tx.lock().map_err(|e| {
                SessionError::SpawnFailed(format!("Failed to lock output_tx: {e}"))
            })?;
            *guard = Some(tx);
        }

        // Spawn reader thread: bridges sync SSH reads to async tokio channel.
        let channel_clone = channel.clone();
        let alive_clone = alive.clone();
        let output_tx_clone = self.output_tx.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while alive_clone.load(Ordering::SeqCst) {
                let result = {
                    let mut ch = match channel_clone.lock() {
                        Ok(ch) => ch,
                        Err(_) => break,
                    };
                    ch.read(&mut buf)
                };
                match result {
                    Ok(0) => break,
                    Ok(n) => {
                        let guard = output_tx_clone.lock().ok();
                        if let Some(ref guard) = guard {
                            if let Some(ref sender) = **guard {
                                let _ = sender.blocking_send(buf[..n].to_vec());
                            } else {
                                break;
                            }
                        } else {
                            break;
                        }
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(std::time::Duration::from_millis(10));
                    }
                    Err(_) => break,
                }
            }
            alive_clone.store(false, Ordering::SeqCst);
        });

        // Create monitoring provider.
        self.monitoring_provider = Some(SshMonitoringProvider::new(config.clone()));

        // Create file browser provider (SFTP).
        self.file_browser_provider = Some(SftpFileBrowser::new(config));

        self.state = Some(ConnectedState {
            session,
            channel,
            alive,
            _x11_forwarder: x11_forwarder,
        });

        Ok(())
    }

    async fn disconnect(&mut self) -> Result<(), SessionError> {
        // Clean up monitoring and file browser.
        if let Some(ref monitoring) = self.monitoring_provider {
            let _ = monitoring.unsubscribe().await;
        }
        self.monitoring_provider = None;
        self.file_browser_provider = None;

        if let Some(state) = self.state.take() {
            state.alive.store(false, Ordering::SeqCst);
            if let Ok(mut channel) = state.channel.lock() {
                // Switch to blocking for clean shutdown.
                state.session.set_blocking(true);
                let _ = channel.send_eof();
                let _ = channel.close();
            }
            // Clear the sender to signal the reader thread to stop.
            if let Ok(mut guard) = self.output_tx.lock() {
                *guard = None;
            }
            debug!("SSH session disconnected");
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
        // Acquire the channel lock BEFORE toggling blocking mode so the reader
        // thread cannot start a blocking read while we hold the session flag.
        let mut channel = state.channel.lock().map_err(|e| {
            SessionError::Io(std::io::Error::other(format!(
                "Failed to lock channel: {e}"
            )))
        })?;
        state.session.set_blocking(true);
        let result = channel.write_all(data);
        state.session.set_blocking(false);
        drop(channel);
        result.map_err(SessionError::Io)
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), SessionError> {
        let state = self
            .state
            .as_ref()
            .ok_or_else(|| SessionError::NotRunning("Not connected".to_string()))?;
        let mut channel = state.channel.lock().map_err(|e| {
            SessionError::Io(std::io::Error::other(format!(
                "Failed to lock channel: {e}"
            )))
        })?;
        state.session.set_blocking(true);
        let result = channel.request_pty_size(cols as u32, rows as u32, None, None);
        state.session.set_blocking(false);
        drop(channel);
        result.map_err(|e| {
            SessionError::Io(std::io::Error::other(format!("PTY resize failed: {e}")))
        })
    }

    fn subscribe_output(&self) -> OutputReceiver {
        let (tx, rx) = tokio::sync::mpsc::channel(OUTPUT_CHANNEL_CAPACITY);
        if let Ok(mut guard) = self.output_tx.lock() {
            *guard = Some(tx);
        }
        rx
    }

    fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
        self.monitoring_provider
            .as_ref()
            .map(|p| p as &dyn MonitoringProvider)
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
        let ssh = Ssh::new();
        assert_eq!(ssh.type_id(), "ssh");
    }

    #[test]
    fn display_name() {
        let ssh = Ssh::new();
        assert_eq!(ssh.display_name(), "SSH");
    }

    #[test]
    fn capabilities() {
        let ssh = Ssh::new();
        let caps = ssh.capabilities();
        assert!(caps.resize);
        assert!(caps.monitoring);
        assert!(caps.file_browser);
        assert!(caps.persistent);
    }

    #[test]
    fn not_connected_initially() {
        let ssh = Ssh::new();
        assert!(!ssh.is_connected());
    }

    #[test]
    fn default_creates_disconnected() {
        let ssh = Ssh::default();
        assert!(!ssh.is_connected());
    }

    #[test]
    fn write_when_disconnected_errors() {
        let ssh = Ssh::new();
        let result = ssh.write(b"hello");
        assert!(result.is_err());
    }

    #[test]
    fn resize_when_disconnected_errors() {
        let ssh = Ssh::new();
        let result = ssh.resize(80, 24);
        assert!(result.is_err());
    }

    #[test]
    fn monitoring_none_when_disconnected() {
        let ssh = Ssh::new();
        assert!(ssh.monitoring().is_none());
    }

    #[test]
    fn file_browser_none_when_disconnected() {
        let ssh = Ssh::new();
        assert!(ssh.file_browser().is_none());
    }

    // --- Schema tests ---

    #[test]
    fn schema_has_three_groups() {
        let ssh = Ssh::new();
        let schema = ssh.settings_schema();
        assert_eq!(schema.groups.len(), 3);
        assert_eq!(schema.groups[0].key, "connection");
        assert_eq!(schema.groups[1].key, "authentication");
        assert_eq!(schema.groups[2].key, "advanced");
    }

    #[test]
    fn schema_connection_group_fields() {
        let ssh = Ssh::new();
        let schema = ssh.settings_schema();
        let group = &schema.groups[0];
        let keys: Vec<&str> = group.fields.iter().map(|f| f.key.as_str()).collect();
        assert_eq!(keys, vec!["host", "port", "username"]);
    }

    #[test]
    fn schema_authentication_group_fields() {
        let ssh = Ssh::new();
        let schema = ssh.settings_schema();
        let group = &schema.groups[1];
        let keys: Vec<&str> = group.fields.iter().map(|f| f.key.as_str()).collect();
        assert_eq!(keys, vec!["authMethod", "password", "keyPath", "savePassword"]);
    }

    #[test]
    fn schema_advanced_group_fields() {
        let ssh = Ssh::new();
        let schema = ssh.settings_schema();
        let group = &schema.groups[2];
        let keys: Vec<&str> = group.fields.iter().map(|f| f.key.as_str()).collect();
        assert_eq!(keys, vec!["shell", "enableX11Forwarding", "env"]);
    }

    #[test]
    fn schema_host_field_properties() {
        let ssh = Ssh::new();
        let schema = ssh.settings_schema();
        let host = schema.groups[0]
            .fields
            .iter()
            .find(|f| f.key == "host")
            .unwrap();
        assert!(host.required);
        assert!(host.supports_env_expansion);
        assert!(!host.supports_tilde_expansion);
        assert!(matches!(host.field_type, FieldType::Text));
    }

    #[test]
    fn schema_port_field_properties() {
        let ssh = Ssh::new();
        let schema = ssh.settings_schema();
        let port = schema.groups[0]
            .fields
            .iter()
            .find(|f| f.key == "port")
            .unwrap();
        assert!(port.required);
        assert!(matches!(port.field_type, FieldType::Port));
        assert_eq!(port.default, Some(serde_json::json!(22)));
    }

    #[test]
    fn schema_auth_method_is_select() {
        let ssh = Ssh::new();
        let schema = ssh.settings_schema();
        let auth = schema.groups[1]
            .fields
            .iter()
            .find(|f| f.key == "authMethod")
            .unwrap();
        assert!(auth.required);
        if let FieldType::Select { ref options } = auth.field_type {
            assert_eq!(options.len(), 3);
            let values: Vec<&str> = options.iter().map(|o| o.value.as_str()).collect();
            assert!(values.contains(&"key"));
            assert!(values.contains(&"password"));
            assert!(values.contains(&"agent"));
        } else {
            panic!("expected Select field type");
        }
    }

    #[test]
    fn schema_password_conditional_visibility() {
        let ssh = Ssh::new();
        let schema = ssh.settings_schema();
        let password = schema.groups[1]
            .fields
            .iter()
            .find(|f| f.key == "password")
            .unwrap();
        let cond = password.visible_when.as_ref().unwrap();
        assert_eq!(cond.field, "authMethod");
        assert_eq!(cond.equals, serde_json::json!("password"));
    }

    #[test]
    fn schema_key_path_conditional_visibility() {
        let ssh = Ssh::new();
        let schema = ssh.settings_schema();
        let key_path = schema.groups[1]
            .fields
            .iter()
            .find(|f| f.key == "keyPath")
            .unwrap();
        let cond = key_path.visible_when.as_ref().unwrap();
        assert_eq!(cond.field, "authMethod");
        assert_eq!(cond.equals, serde_json::json!("key"));
        assert!(key_path.supports_tilde_expansion);
        assert!(matches!(
            key_path.field_type,
            FieldType::FilePath {
                kind: FilePathKind::File
            }
        ));
    }

    #[test]
    fn schema_x11_is_boolean() {
        let ssh = Ssh::new();
        let schema = ssh.settings_schema();
        let x11 = schema.groups[2]
            .fields
            .iter()
            .find(|f| f.key == "enableX11Forwarding")
            .unwrap();
        assert!(matches!(x11.field_type, FieldType::Boolean));
        assert_eq!(x11.default, Some(serde_json::json!(false)));
    }

    #[test]
    fn schema_env_is_key_value_list() {
        let ssh = Ssh::new();
        let schema = ssh.settings_schema();
        let env = schema.groups[2]
            .fields
            .iter()
            .find(|f| f.key == "env")
            .unwrap();
        assert!(matches!(env.field_type, FieldType::KeyValueList));
    }

    // --- Settings validation tests ---

    #[test]
    fn validation_missing_host_fails() {
        let ssh = Ssh::new();
        let schema = ssh.settings_schema();
        let settings = serde_json::json!({
            "port": 22,
            "username": "user",
            "authMethod": "password",
        });
        let errors = validate_settings(&schema, &settings);
        assert!(!errors.is_empty());
        assert!(errors.iter().any(|e| e.field == "host"));
    }

    #[test]
    fn validation_missing_username_fails() {
        let ssh = Ssh::new();
        let schema = ssh.settings_schema();
        let settings = serde_json::json!({
            "host": "example.com",
            "port": 22,
            "authMethod": "password",
        });
        let errors = validate_settings(&schema, &settings);
        assert!(!errors.is_empty());
        assert!(errors.iter().any(|e| e.field == "username"));
    }

    #[test]
    fn validation_valid_password_auth() {
        let ssh = Ssh::new();
        let schema = ssh.settings_schema();
        let settings = serde_json::json!({
            "host": "example.com",
            "port": 22,
            "username": "admin",
            "authMethod": "password",
            "password": "secret",
        });
        let errors = validate_settings(&schema, &settings);
        assert!(errors.is_empty(), "errors: {errors:?}");
    }

    #[test]
    fn validation_valid_key_auth() {
        let ssh = Ssh::new();
        let schema = ssh.settings_schema();
        let settings = serde_json::json!({
            "host": "example.com",
            "port": 22,
            "username": "admin",
            "authMethod": "key",
            "keyPath": "~/.ssh/id_rsa",
        });
        let errors = validate_settings(&schema, &settings);
        assert!(errors.is_empty(), "errors: {errors:?}");
    }

    #[test]
    fn validation_valid_agent_auth() {
        let ssh = Ssh::new();
        let schema = ssh.settings_schema();
        let settings = serde_json::json!({
            "host": "example.com",
            "port": 22,
            "username": "admin",
            "authMethod": "agent",
        });
        let errors = validate_settings(&schema, &settings);
        assert!(errors.is_empty(), "errors: {errors:?}");
    }

    #[test]
    fn validation_key_auth_hides_password() {
        let ssh = Ssh::new();
        let schema = ssh.settings_schema();
        // When authMethod=key, password field is hidden, so no error even if missing.
        let settings = serde_json::json!({
            "host": "example.com",
            "port": 22,
            "username": "admin",
            "authMethod": "key",
        });
        let errors = validate_settings(&schema, &settings);
        assert!(
            !errors.iter().any(|e| e.field == "password"),
            "password should be hidden: {errors:?}"
        );
    }

    #[test]
    fn validation_invalid_auth_method() {
        let ssh = Ssh::new();
        let schema = ssh.settings_schema();
        let settings = serde_json::json!({
            "host": "example.com",
            "port": 22,
            "username": "admin",
            "authMethod": "token",
        });
        let errors = validate_settings(&schema, &settings);
        assert!(errors.iter().any(|e| e.field == "authMethod"));
    }

    #[test]
    fn validation_valid_with_advanced_settings() {
        let ssh = Ssh::new();
        let schema = ssh.settings_schema();
        let settings = serde_json::json!({
            "host": "example.com",
            "port": 2222,
            "username": "admin",
            "authMethod": "agent",
            "shell": "/bin/bash",
            "enableX11Forwarding": true,
            "env": [
                {"key": "LANG", "value": "en_US.UTF-8"}
            ],
        });
        let errors = validate_settings(&schema, &settings);
        assert!(errors.is_empty(), "errors: {errors:?}");
    }

    // --- Settings parsing tests ---

    #[test]
    fn parse_minimal_settings() {
        let settings = serde_json::json!({
            "host": "example.com",
            "username": "admin",
            "authMethod": "password",
        });
        let config = parse_ssh_settings(&settings);
        assert_eq!(config.host, "example.com");
        assert_eq!(config.port, 22);
        assert_eq!(config.username, "admin");
        assert_eq!(config.auth_method, "password");
        assert!(!config.enable_x11_forwarding);
        assert!(config.env.is_empty());
    }

    #[test]
    fn parse_full_settings() {
        let settings = serde_json::json!({
            "host": "server.example.com",
            "port": 2222,
            "username": "deploy",
            "authMethod": "key",
            "keyPath": "~/.ssh/id_ed25519",
            "shell": "/bin/zsh",
            "enableX11Forwarding": true,
            "savePassword": true,
            "env": [
                {"key": "LANG", "value": "en_US.UTF-8"},
                {"key": "TERM", "value": "xterm-256color"}
            ],
        });
        let config = parse_ssh_settings(&settings);
        assert_eq!(config.host, "server.example.com");
        assert_eq!(config.port, 2222);
        assert_eq!(config.username, "deploy");
        assert_eq!(config.auth_method, "key");
        assert_eq!(config.key_path.as_deref(), Some("~/.ssh/id_ed25519"));
        assert_eq!(config.shell.as_deref(), Some("/bin/zsh"));
        assert!(config.enable_x11_forwarding);
        assert_eq!(config.save_password, Some(true));
        assert_eq!(config.env.len(), 2);
        assert_eq!(config.env.get("LANG").unwrap(), "en_US.UTF-8");
    }

    #[test]
    fn parse_port_as_string() {
        let settings = serde_json::json!({
            "host": "example.com",
            "port": "2222",
            "username": "admin",
            "authMethod": "agent",
        });
        let config = parse_ssh_settings(&settings);
        assert_eq!(config.port, 2222);
    }

    // --- Async tests ---

    #[tokio::test]
    async fn connect_empty_host_fails() {
        let mut ssh = Ssh::new();
        let settings = serde_json::json!({
            "host": "",
            "port": 22,
            "username": "admin",
            "authMethod": "password",
        });
        let result = ssh.connect(settings).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn connect_empty_username_fails() {
        let mut ssh = Ssh::new();
        let settings = serde_json::json!({
            "host": "example.com",
            "port": 22,
            "username": "",
            "authMethod": "password",
        });
        let result = ssh.connect(settings).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn disconnect_when_not_connected_is_noop() {
        let mut ssh = Ssh::new();
        ssh.disconnect()
            .await
            .expect("disconnect should not fail");
    }
}
