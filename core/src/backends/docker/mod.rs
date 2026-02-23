//! Docker backend implementing [`ConnectionType`](crate::connection::ConnectionType).
//!
//! Provides terminal I/O to Docker containers with in-container file
//! browsing via `docker exec`. Uses the [`bollard`] crate for async
//! Docker API access instead of shelling out to the Docker CLI.

mod file_browser;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use bollard::container::{
    Config, CreateContainerOptions, RemoveContainerOptions, StopContainerOptions,
};
use bollard::exec::{CreateExecOptions, ResizeExecOptions, StartExecOptions, StartExecResults};
use bollard::image::CreateImageOptions;
use bollard::models::HostConfig;
use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;
use tracing::{debug, info, warn};

use crate::config::DockerConfig;
use crate::connection::{
    Capabilities, ConnectionType, FieldType, OutputReceiver, OutputSender, SettingsField,
    SettingsGroup, SettingsSchema,
};
use crate::errors::SessionError;
use crate::files::FileBrowser;
use crate::monitoring::MonitoringProvider;
use crate::session::docker::validate_docker_config;

use self::file_browser::DockerFileBrowser;

/// Channel capacity for output data from the Docker reader task.
const OUTPUT_CHANNEL_CAPACITY: usize = 64;

/// Default container name prefix.
const CONTAINER_PREFIX: &str = "termihub";

/// Docker backend using `bollard`, implementing [`ConnectionType`].
///
/// # Lifecycle
///
/// 1. Create with [`Docker::new()`] (disconnected state).
/// 2. Call [`connect()`](ConnectionType::connect) with settings JSON.
/// 3. Use [`write()`](ConnectionType::write),
///    [`subscribe_output()`](ConnectionType::subscribe_output) for I/O.
/// 4. Optional: [`file_browser()`](ConnectionType::file_browser).
/// 5. Call [`disconnect()`](ConnectionType::disconnect) to clean up.
pub struct Docker {
    /// State is `None` when disconnected, `Some` when connected.
    state: Option<ConnectedState>,
    /// The output sender is stored so `subscribe_output()` can replace
    /// the channel. The reader task also holds a reference and picks up
    /// the replacement on its next iteration.
    output_tx: Arc<Mutex<Option<OutputSender>>>,
    /// File browser provider, created on connect.
    file_browser_provider: Option<DockerFileBrowser>,
}

/// Internal state of an active Docker connection.
struct ConnectedState {
    /// The bollard Docker client.
    client: bollard::Docker,
    /// Docker container ID (full hash).
    container_id: String,
    /// The exec instance ID for the interactive shell.
    exec_id: String,
    /// Whether to remove the container on disconnect.
    remove_on_exit: bool,
    /// Shared alive flag — set to `false` to signal the reader task to stop.
    alive: Arc<AtomicBool>,
    /// Sender for writing to the exec stdin.
    stdin_tx: tokio::sync::mpsc::Sender<Vec<u8>>,
}

impl Docker {
    /// Create a new disconnected `Docker` instance.
    pub fn new() -> Self {
        Self {
            state: None,
            output_tx: Arc::new(Mutex::new(None)),
            file_browser_provider: None,
        }
    }
}

impl Default for Docker {
    fn default() -> Self {
        Self::new()
    }
}

/// Parse settings JSON into a `DockerConfig`.
fn parse_docker_settings(settings: &serde_json::Value) -> DockerConfig {
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

    let env_vars = settings
        .get("envVars")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    let k = item.get("key").and_then(|v| v.as_str())?;
                    let v = item.get("value").and_then(|v| v.as_str())?;
                    Some(crate::config::EnvVar {
                        key: k.to_string(),
                        value: v.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let volumes = settings
        .get("volumes")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    let host = item.get("hostPath").and_then(|v| v.as_str())?;
                    let container = item.get("containerPath").and_then(|v| v.as_str())?;
                    let read_only = item
                        .get("readOnly")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    Some(crate::config::VolumeMount {
                        host_path: host.to_string(),
                        container_path: container.to_string(),
                        read_only,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    DockerConfig {
        image: str_field("image"),
        shell: opt_str("shell"),
        cols: 80,
        rows: 24,
        env_vars,
        volumes,
        working_directory: opt_str("workingDirectory"),
        remove_on_exit: bool_field("removeOnExit", true),
        env: std::collections::HashMap::new(),
    }
}

/// Generate a unique container name for this session.
fn generate_container_name() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("{CONTAINER_PREFIX}-{ts}")
}

#[async_trait::async_trait]
impl ConnectionType for Docker {
    fn type_id(&self) -> &str {
        "docker"
    }

    fn display_name(&self) -> &str {
        "Docker"
    }

    fn settings_schema(&self) -> SettingsSchema {
        SettingsSchema {
            groups: vec![
                SettingsGroup {
                    key: "container".to_string(),
                    label: "Container".to_string(),
                    fields: vec![
                        SettingsField {
                            key: "image".to_string(),
                            label: "Image".to_string(),
                            description: Some(
                                "Docker image to use (e.g., ubuntu:22.04)".to_string(),
                            ),
                            field_type: FieldType::Text,
                            required: true,
                            default: None,
                            placeholder: Some("ubuntu:22.04".to_string()),
                            supports_env_expansion: true,
                            supports_tilde_expansion: false,
                            visible_when: None,
                        },
                        SettingsField {
                            key: "shell".to_string(),
                            label: "Shell".to_string(),
                            description: Some(
                                "Shell to use inside the container (leave empty for /bin/sh)"
                                    .to_string(),
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
                            key: "workingDirectory".to_string(),
                            label: "Working Directory".to_string(),
                            description: Some(
                                "Initial working directory inside the container".to_string(),
                            ),
                            field_type: FieldType::Text,
                            required: false,
                            default: None,
                            placeholder: Some("/workspace".to_string()),
                            supports_env_expansion: false,
                            supports_tilde_expansion: true,
                            visible_when: None,
                        },
                        SettingsField {
                            key: "removeOnExit".to_string(),
                            label: "Remove on Exit".to_string(),
                            description: Some(
                                "Remove the container when the session is closed".to_string(),
                            ),
                            field_type: FieldType::Boolean,
                            required: false,
                            default: Some(serde_json::json!(true)),
                            placeholder: None,
                            supports_env_expansion: false,
                            supports_tilde_expansion: false,
                            visible_when: None,
                        },
                    ],
                },
                SettingsGroup {
                    key: "environment".to_string(),
                    label: "Environment".to_string(),
                    fields: vec![
                        SettingsField {
                            key: "envVars".to_string(),
                            label: "Variables".to_string(),
                            description: Some(
                                "Environment variables to set inside the container".to_string(),
                            ),
                            field_type: FieldType::KeyValueList,
                            required: false,
                            default: None,
                            placeholder: None,
                            supports_env_expansion: true,
                            supports_tilde_expansion: false,
                            visible_when: None,
                        },
                        SettingsField {
                            key: "volumes".to_string(),
                            label: "Volumes".to_string(),
                            description: Some("Volume mounts from host to container".to_string()),
                            field_type: FieldType::ObjectList {
                                fields: vec![
                                    SettingsField {
                                        key: "hostPath".to_string(),
                                        label: "Host Path".to_string(),
                                        description: Some("Path on the host machine".to_string()),
                                        field_type: FieldType::Text,
                                        required: true,
                                        default: None,
                                        placeholder: Some("/home/user/project".to_string()),
                                        supports_env_expansion: true,
                                        supports_tilde_expansion: true,
                                        visible_when: None,
                                    },
                                    SettingsField {
                                        key: "containerPath".to_string(),
                                        label: "Container Path".to_string(),
                                        description: Some("Path inside the container".to_string()),
                                        field_type: FieldType::Text,
                                        required: true,
                                        default: None,
                                        placeholder: Some("/workspace".to_string()),
                                        supports_env_expansion: false,
                                        supports_tilde_expansion: false,
                                        visible_when: None,
                                    },
                                    SettingsField {
                                        key: "readOnly".to_string(),
                                        label: "Read Only".to_string(),
                                        description: Some(
                                            "Mount the volume as read-only".to_string(),
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
                            required: false,
                            default: None,
                            placeholder: None,
                            supports_env_expansion: false,
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

        let config = parse_docker_settings(&settings);
        let config = config.expand();

        validate_docker_config(&config)?;

        info!(image = %config.image, "Connecting Docker session");

        // Connect to the local Docker daemon.
        let client = bollard::Docker::connect_with_local_defaults().map_err(|e| {
            SessionError::SpawnFailed(format!("Failed to connect to Docker daemon: {e}"))
        })?;

        // Pull the image if it's not already available locally.
        info!(image = %config.image, "Pulling Docker image");
        let pull_opts = CreateImageOptions {
            from_image: config.image.as_str(),
            ..Default::default()
        };
        let mut pull_stream = client.create_image(Some(pull_opts), None, None);
        while let Some(result) = pull_stream.next().await {
            match result {
                Ok(info) => {
                    debug!(?info, "Image pull progress");
                }
                Err(e) => {
                    return Err(SessionError::SpawnFailed(format!(
                        "Failed to pull image '{}': {e}",
                        config.image
                    )));
                }
            }
        }
        info!(image = %config.image, "Image ready");

        let container_name = generate_container_name();
        let shell = config
            .shell
            .clone()
            .unwrap_or_else(|| "/bin/sh".to_string());

        // Build environment variables for the container.
        let env: Vec<String> = config
            .env_vars
            .iter()
            .map(|ev| format!("{}={}", ev.key, ev.value))
            .collect();

        // Build volume binds.
        let binds: Vec<String> = config
            .volumes
            .iter()
            .map(|v| {
                let mut bind = format!("{}:{}", v.host_path, v.container_path);
                if v.read_only {
                    bind.push_str(":ro");
                }
                bind
            })
            .collect();

        // Create container configuration.
        let container_config = Config {
            image: Some(config.image.clone()),
            tty: Some(true),
            open_stdin: Some(true),
            env: if env.is_empty() { None } else { Some(env) },
            working_dir: config.working_directory.clone(),
            // Use `tail -f /dev/null` to keep the container alive.
            cmd: Some(vec![
                "tail".to_string(),
                "-f".to_string(),
                "/dev/null".to_string(),
            ]),
            host_config: Some(HostConfig {
                binds: if binds.is_empty() { None } else { Some(binds) },
                init: Some(true),
                ..Default::default()
            }),
            ..Default::default()
        };

        // Create the container.
        let create_opts = CreateContainerOptions {
            name: container_name.as_str(),
            platform: None,
        };
        let create_response = client
            .create_container(Some(create_opts), container_config)
            .await
            .map_err(|e| SessionError::SpawnFailed(format!("Failed to create container: {e}")))?;

        let container_id = create_response.id;
        debug!(container_id = %container_id, "Container created");

        // Start the container.
        client
            .start_container::<String>(&container_id, None)
            .await
            .map_err(|e| SessionError::SpawnFailed(format!("Failed to start container: {e}")))?;

        info!(container_id = %container_id, "Container started");

        // Create an interactive exec instance with the shell.
        let exec_config = CreateExecOptions {
            attach_stdin: Some(true),
            attach_stdout: Some(true),
            attach_stderr: Some(true),
            tty: Some(true),
            cmd: Some(vec![shell]),
            ..Default::default()
        };

        let exec_response = client
            .create_exec(&container_id, exec_config)
            .await
            .map_err(|e| SessionError::SpawnFailed(format!("Failed to create exec: {e}")))?;

        let exec_id = exec_response.id;
        debug!(exec_id = %exec_id, "Exec instance created");

        // Start the exec instance.
        let start_config = StartExecOptions {
            detach: false,
            ..Default::default()
        };

        let exec_result = client
            .start_exec(&exec_id, Some(start_config))
            .await
            .map_err(|e| SessionError::SpawnFailed(format!("Failed to start exec: {e}")))?;

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

        // Set up stdin channel.
        let (stdin_tx, mut stdin_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);

        match exec_result {
            StartExecResults::Attached { mut output, input } => {
                // Spawn reader task: forwards exec output to the output channel.
                let alive_clone = alive.clone();
                let output_tx_clone = self.output_tx.clone();
                tokio::spawn(async move {
                    while alive_clone.load(Ordering::SeqCst) {
                        match output.next().await {
                            Some(Ok(log_output)) => {
                                let bytes = log_output.into_bytes();
                                if bytes.is_empty() {
                                    continue;
                                }
                                // Clone the sender out of the lock before awaiting.
                                let sender =
                                    output_tx_clone.lock().ok().and_then(|guard| guard.clone());
                                if let Some(sender) = sender {
                                    if sender.send(bytes.to_vec()).await.is_err() {
                                        break;
                                    }
                                } else {
                                    break;
                                }
                            }
                            Some(Err(e)) => {
                                warn!("Docker exec output error: {e}");
                                break;
                            }
                            None => break,
                        }
                    }
                    alive_clone.store(false, Ordering::SeqCst);
                });

                // Spawn stdin writer task: forwards stdin channel to exec input.
                let alive_clone = alive.clone();
                tokio::spawn(async move {
                    let mut input = input;
                    while alive_clone.load(Ordering::SeqCst) {
                        match stdin_rx.recv().await {
                            Some(data) => {
                                if input.write_all(&data).await.is_err() {
                                    break;
                                }
                                if input.flush().await.is_err() {
                                    break;
                                }
                            }
                            None => break,
                        }
                    }
                });
            }
            StartExecResults::Detached => {
                return Err(SessionError::SpawnFailed(
                    "Exec started in detached mode unexpectedly".to_string(),
                ));
            }
        }

        // Create file browser provider.
        self.file_browser_provider =
            Some(DockerFileBrowser::new(client.clone(), container_id.clone()));

        self.state = Some(ConnectedState {
            client,
            container_id,
            exec_id,
            remove_on_exit: config.remove_on_exit,
            alive,
            stdin_tx,
        });

        Ok(())
    }

    async fn disconnect(&mut self) -> Result<(), SessionError> {
        self.file_browser_provider = None;

        if let Some(state) = self.state.take() {
            state.alive.store(false, Ordering::SeqCst);

            // Drop the stdin sender to signal the writer task to stop.
            drop(state.stdin_tx);

            // Clear the output sender to signal the reader task to stop.
            if let Ok(mut guard) = self.output_tx.lock() {
                *guard = None;
            }

            // Stop the container (5-second timeout).
            let stop_result = state
                .client
                .stop_container(&state.container_id, Some(StopContainerOptions { t: 5 }))
                .await;

            if let Err(e) = stop_result {
                warn!(
                    container_id = %state.container_id,
                    "Failed to stop container: {e}"
                );
            }

            // Optionally remove the container.
            if state.remove_on_exit {
                let remove_result = state
                    .client
                    .remove_container(
                        &state.container_id,
                        Some(RemoveContainerOptions {
                            force: true,
                            ..Default::default()
                        }),
                    )
                    .await;

                if let Err(e) = remove_result {
                    warn!(
                        container_id = %state.container_id,
                        "Failed to remove container: {e}"
                    );
                }
            }

            debug!("Docker session disconnected");
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

        state
            .stdin_tx
            .try_send(data.to_vec())
            .map_err(|e| SessionError::Io(std::io::Error::other(format!("Write failed: {e}"))))
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), SessionError> {
        let state = self
            .state
            .as_ref()
            .ok_or_else(|| SessionError::NotRunning("Not connected".to_string()))?;

        let client = state.client.clone();
        let exec_id = state.exec_id.clone();
        let options = ResizeExecOptions {
            width: cols,
            height: rows,
        };

        // Spawn a task to perform the async resize.
        tokio::spawn(async move {
            if let Err(e) = client.resize_exec(&exec_id, options).await {
                warn!("Docker exec resize failed: {e}");
            }
        });

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

    // --- Metadata tests ---

    #[test]
    fn type_id() {
        let docker = Docker::new();
        assert_eq!(docker.type_id(), "docker");
    }

    #[test]
    fn display_name() {
        let docker = Docker::new();
        assert_eq!(docker.display_name(), "Docker");
    }

    #[test]
    fn capabilities() {
        let docker = Docker::new();
        let caps = docker.capabilities();
        assert!(!caps.monitoring);
        assert!(caps.file_browser);
        assert!(caps.resize);
        assert!(caps.persistent);
    }

    #[test]
    fn not_connected_initially() {
        let docker = Docker::new();
        assert!(!docker.is_connected());
    }

    #[test]
    fn default_creates_disconnected() {
        let docker = Docker::default();
        assert!(!docker.is_connected());
    }

    #[test]
    fn write_when_disconnected_errors() {
        let docker = Docker::new();
        let result = docker.write(b"hello");
        assert!(result.is_err());
    }

    #[test]
    fn resize_when_disconnected_errors() {
        let docker = Docker::new();
        let result = docker.resize(80, 24);
        assert!(result.is_err());
    }

    #[test]
    fn monitoring_always_none() {
        let docker = Docker::new();
        assert!(docker.monitoring().is_none());
    }

    #[test]
    fn file_browser_none_when_disconnected() {
        let docker = Docker::new();
        assert!(docker.file_browser().is_none());
    }

    #[tokio::test]
    async fn disconnect_when_not_connected_is_noop() {
        let mut docker = Docker::new();
        docker
            .disconnect()
            .await
            .expect("disconnect should not fail");
    }

    // --- Schema tests ---

    #[test]
    fn schema_has_two_groups() {
        let docker = Docker::new();
        let schema = docker.settings_schema();
        assert_eq!(schema.groups.len(), 2);
        assert_eq!(schema.groups[0].key, "container");
        assert_eq!(schema.groups[1].key, "environment");
    }

    #[test]
    fn schema_container_group_fields() {
        let docker = Docker::new();
        let schema = docker.settings_schema();
        let group = &schema.groups[0];
        let keys: Vec<&str> = group.fields.iter().map(|f| f.key.as_str()).collect();
        assert_eq!(
            keys,
            vec!["image", "shell", "workingDirectory", "removeOnExit"]
        );
    }

    #[test]
    fn schema_environment_group_fields() {
        let docker = Docker::new();
        let schema = docker.settings_schema();
        let group = &schema.groups[1];
        let keys: Vec<&str> = group.fields.iter().map(|f| f.key.as_str()).collect();
        assert_eq!(keys, vec!["envVars", "volumes"]);
    }

    #[test]
    fn schema_image_field_properties() {
        let docker = Docker::new();
        let schema = docker.settings_schema();
        let image = schema.groups[0]
            .fields
            .iter()
            .find(|f| f.key == "image")
            .unwrap();
        assert!(image.required);
        assert!(image.supports_env_expansion);
        assert!(!image.supports_tilde_expansion);
        assert!(matches!(image.field_type, FieldType::Text));
    }

    #[test]
    fn schema_shell_field_properties() {
        let docker = Docker::new();
        let schema = docker.settings_schema();
        let shell = schema.groups[0]
            .fields
            .iter()
            .find(|f| f.key == "shell")
            .unwrap();
        assert!(!shell.required);
        assert!(matches!(shell.field_type, FieldType::Text));
    }

    #[test]
    fn schema_working_directory_tilde_expansion() {
        let docker = Docker::new();
        let schema = docker.settings_schema();
        let wd = schema.groups[0]
            .fields
            .iter()
            .find(|f| f.key == "workingDirectory")
            .unwrap();
        assert!(!wd.required);
        assert!(wd.supports_tilde_expansion);
    }

    #[test]
    fn schema_remove_on_exit_is_boolean() {
        let docker = Docker::new();
        let schema = docker.settings_schema();
        let roe = schema.groups[0]
            .fields
            .iter()
            .find(|f| f.key == "removeOnExit")
            .unwrap();
        assert!(matches!(roe.field_type, FieldType::Boolean));
        assert_eq!(roe.default, Some(serde_json::json!(true)));
    }

    #[test]
    fn schema_env_vars_is_key_value_list() {
        let docker = Docker::new();
        let schema = docker.settings_schema();
        let ev = schema.groups[1]
            .fields
            .iter()
            .find(|f| f.key == "envVars")
            .unwrap();
        assert!(matches!(ev.field_type, FieldType::KeyValueList));
        assert!(ev.supports_env_expansion);
    }

    #[test]
    fn schema_volumes_is_object_list() {
        let docker = Docker::new();
        let schema = docker.settings_schema();
        let vol = schema.groups[1]
            .fields
            .iter()
            .find(|f| f.key == "volumes")
            .unwrap();
        if let FieldType::ObjectList { ref fields } = vol.field_type {
            assert_eq!(fields.len(), 3);
            let keys: Vec<&str> = fields.iter().map(|f| f.key.as_str()).collect();
            assert_eq!(keys, vec!["hostPath", "containerPath", "readOnly"]);
        } else {
            panic!("expected ObjectList field type");
        }
    }

    #[test]
    fn schema_volumes_host_path_properties() {
        let docker = Docker::new();
        let schema = docker.settings_schema();
        let vol = schema.groups[1]
            .fields
            .iter()
            .find(|f| f.key == "volumes")
            .unwrap();
        if let FieldType::ObjectList { ref fields } = vol.field_type {
            let host = fields.iter().find(|f| f.key == "hostPath").unwrap();
            assert!(host.required);
            assert!(host.supports_env_expansion);
            assert!(host.supports_tilde_expansion);
        } else {
            panic!("expected ObjectList");
        }
    }

    // --- Settings validation tests ---

    #[test]
    fn validation_missing_image_fails() {
        let docker = Docker::new();
        let schema = docker.settings_schema();
        let settings = serde_json::json!({});
        let errors = validate_settings(&schema, &settings);
        assert!(!errors.is_empty());
        assert!(errors.iter().any(|e| e.field == "image"));
    }

    #[test]
    fn validation_valid_minimal_settings() {
        let docker = Docker::new();
        let schema = docker.settings_schema();
        let settings = serde_json::json!({
            "image": "ubuntu:22.04",
        });
        let errors = validate_settings(&schema, &settings);
        assert!(errors.is_empty(), "errors: {errors:?}");
    }

    #[test]
    fn validation_valid_full_settings() {
        let docker = Docker::new();
        let schema = docker.settings_schema();
        let settings = serde_json::json!({
            "image": "ubuntu:22.04",
            "shell": "/bin/bash",
            "workingDirectory": "/workspace",
            "removeOnExit": false,
            "envVars": [
                {"key": "TERM", "value": "xterm-256color"},
            ],
            "volumes": [
                {
                    "hostPath": "/home/user/project",
                    "containerPath": "/workspace",
                    "readOnly": false,
                },
            ],
        });
        let errors = validate_settings(&schema, &settings);
        assert!(errors.is_empty(), "errors: {errors:?}");
    }

    #[test]
    fn validation_invalid_volumes_missing_host_path() {
        let docker = Docker::new();
        let schema = docker.settings_schema();
        let settings = serde_json::json!({
            "image": "alpine",
            "volumes": [
                {
                    "containerPath": "/data",
                },
            ],
        });
        let errors = validate_settings(&schema, &settings);
        assert!(
            errors.iter().any(|e| e.field.contains("hostPath")),
            "expected hostPath error: {errors:?}"
        );
    }

    #[test]
    fn validation_invalid_volumes_missing_container_path() {
        let docker = Docker::new();
        let schema = docker.settings_schema();
        let settings = serde_json::json!({
            "image": "alpine",
            "volumes": [
                {
                    "hostPath": "/host",
                },
            ],
        });
        let errors = validate_settings(&schema, &settings);
        assert!(
            errors.iter().any(|e| e.field.contains("containerPath")),
            "expected containerPath error: {errors:?}"
        );
    }

    // --- Settings parsing tests ---

    #[test]
    fn parse_minimal_settings() {
        let settings = serde_json::json!({
            "image": "alpine",
        });
        let config = parse_docker_settings(&settings);
        assert_eq!(config.image, "alpine");
        assert!(config.shell.is_none());
        assert!(config.working_directory.is_none());
        assert!(config.remove_on_exit);
        assert!(config.env_vars.is_empty());
        assert!(config.volumes.is_empty());
    }

    #[test]
    fn parse_full_settings() {
        let settings = serde_json::json!({
            "image": "ubuntu:22.04",
            "shell": "/bin/bash",
            "workingDirectory": "/app",
            "removeOnExit": false,
            "envVars": [
                {"key": "LANG", "value": "en_US.UTF-8"},
                {"key": "TERM", "value": "xterm-256color"},
            ],
            "volumes": [
                {
                    "hostPath": "/tmp",
                    "containerPath": "/mnt/tmp",
                    "readOnly": true,
                },
            ],
        });
        let config = parse_docker_settings(&settings);
        assert_eq!(config.image, "ubuntu:22.04");
        assert_eq!(config.shell.as_deref(), Some("/bin/bash"));
        assert_eq!(config.working_directory.as_deref(), Some("/app"));
        assert!(!config.remove_on_exit);
        assert_eq!(config.env_vars.len(), 2);
        assert_eq!(config.env_vars[0].key, "LANG");
        assert_eq!(config.env_vars[0].value, "en_US.UTF-8");
        assert_eq!(config.volumes.len(), 1);
        assert_eq!(config.volumes[0].host_path, "/tmp");
        assert_eq!(config.volumes[0].container_path, "/mnt/tmp");
        assert!(config.volumes[0].read_only);
    }

    #[test]
    fn parse_remove_on_exit_defaults_true() {
        let settings = serde_json::json!({
            "image": "alpine",
        });
        let config = parse_docker_settings(&settings);
        assert!(config.remove_on_exit);
    }

    #[test]
    fn parse_empty_shell_is_none() {
        let settings = serde_json::json!({
            "image": "alpine",
            "shell": "",
        });
        let config = parse_docker_settings(&settings);
        assert!(config.shell.is_none());
    }

    #[test]
    fn parse_skips_invalid_env_vars() {
        let settings = serde_json::json!({
            "image": "alpine",
            "envVars": [
                {"key": "VALID", "value": "yes"},
                {"notKey": "invalid"},
                {"key": "ALSO_VALID", "value": "yes"},
            ],
        });
        let config = parse_docker_settings(&settings);
        assert_eq!(config.env_vars.len(), 2);
    }

    #[test]
    fn parse_skips_invalid_volumes() {
        let settings = serde_json::json!({
            "image": "alpine",
            "volumes": [
                {"hostPath": "/host", "containerPath": "/container"},
                {"hostPath": "/host"},
                {"containerPath": "/container"},
            ],
        });
        let config = parse_docker_settings(&settings);
        assert_eq!(config.volumes.len(), 1);
    }

    #[tokio::test]
    async fn connect_empty_image_fails() {
        let mut docker = Docker::new();
        let settings = serde_json::json!({
            "image": "",
        });
        let result = docker.connect(settings).await;
        assert!(result.is_err());
    }
}
