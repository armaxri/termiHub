//! Docker session helpers — pure-logic functions for Docker CLI argument
//! building, config validation, and container lifecycle commands.
//!
//! These functions extract duplicated Docker-setup logic from the desktop
//! (`docker_shell.rs`) and agent (`docker/backend.rs`) crates into shared,
//! testable pure functions with no I/O, no process spawning, and no async.

use crate::config::DockerConfig;
use crate::errors::SessionError;

/// Build the shared portion of `docker run` arguments from a [`DockerConfig`].
///
/// Returns environment variables (`-e KEY=VALUE`), volume mounts
/// (`-v HOST:CONTAINER[:ro]`), working directory (`-w DIR`), the image
/// name, and an optional shell command — but **not** consumer-specific
/// flags like `-it`, `--rm`, `-d`, `--init`, or `--name`.
///
/// Consumers prepend their own flags before these args:
/// - Desktop adds: `-it`, `--rm`
/// - Agent adds: `-d`, `--init`, `--name <name>` (and appends
///   `tail -f /dev/null` instead of the shell)
pub fn build_docker_run_args(config: &DockerConfig) -> Vec<String> {
    let mut args = Vec::new();

    // Environment variables
    for env_var in &config.env_vars {
        args.push("-e".to_string());
        args.push(format!("{}={}", env_var.key, env_var.value));
    }

    // Volume mounts
    for volume in &config.volumes {
        args.push("-v".to_string());
        let mut mount = format!("{}:{}", volume.host_path, volume.container_path);
        if volume.read_only {
            mount.push_str(":ro");
        }
        args.push(mount);
    }

    // Working directory
    if let Some(ref workdir) = config.working_directory {
        if !workdir.is_empty() {
            args.push("-w".to_string());
            args.push(workdir.clone());
        }
    }

    // Image
    args.push(config.image.clone());

    // Shell (optional)
    if let Some(ref shell) = config.shell {
        if !shell.is_empty() {
            args.push(shell.clone());
        }
    }

    args
}

/// Build `docker exec` arguments for attaching to an existing container.
///
/// Returns `["exec", "-it", container, shell]`.
pub fn build_docker_exec_args(container: &str, shell: &str) -> Vec<String> {
    vec![
        "exec".to_string(),
        "-it".to_string(),
        container.to_string(),
        shell.to_string(),
    ]
}

/// Validate a [`DockerConfig`] before session creation.
///
/// Checks that the image is non-empty, all environment variable keys are
/// non-empty, and all volume mount paths (host and container) are non-empty.
///
/// # Errors
///
/// Returns [`SessionError::InvalidConfig`] with a descriptive message if
/// validation fails.
pub fn validate_docker_config(config: &DockerConfig) -> Result<(), SessionError> {
    if config.image.is_empty() {
        return Err(SessionError::InvalidConfig(
            "Docker image must not be empty".to_string(),
        ));
    }

    for env_var in &config.env_vars {
        if env_var.key.is_empty() {
            return Err(SessionError::InvalidConfig(
                "Environment variable key must not be empty".to_string(),
            ));
        }
    }

    for volume in &config.volumes {
        if volume.host_path.is_empty() {
            return Err(SessionError::InvalidConfig(
                "Volume host path must not be empty".to_string(),
            ));
        }
        if volume.container_path.is_empty() {
            return Err(SessionError::InvalidConfig(
                "Volume container path must not be empty".to_string(),
            ));
        }
    }

    Ok(())
}

/// Docker container lifecycle command builder.
///
/// Provides methods to generate CLI argument vectors for inspecting and
/// cleaning up Docker containers. Consumers pass these to their own
/// process-spawning layer.
pub struct DockerContainer {
    /// Container name.
    pub name: String,
    /// Docker image used to create the container.
    pub image: String,
    /// Whether to force-remove the container on cleanup.
    pub remove_on_exit: bool,
}

impl DockerContainer {
    /// Create a new `DockerContainer` descriptor.
    pub fn new(name: String, image: String, remove_on_exit: bool) -> Self {
        Self {
            name,
            image,
            remove_on_exit,
        }
    }

    /// Returns args for checking if the container is running.
    ///
    /// Produces: `["inspect", "-f", "{{.State.Running}}", <name>]`.
    pub fn is_running_command(&self) -> Vec<String> {
        vec![
            "inspect".to_string(),
            "-f".to_string(),
            "{{.State.Running}}".to_string(),
            self.name.clone(),
        ]
    }

    /// Returns argument vectors for stopping and optionally removing the
    /// container.
    ///
    /// Always includes a stop command: `["stop", "-t", "5", <name>]`.
    /// If `remove_on_exit` is `true`, also includes: `["rm", "-f", <name>]`.
    pub fn cleanup_args(&self) -> Vec<Vec<String>> {
        let mut commands = vec![vec![
            "stop".to_string(),
            "-t".to_string(),
            "5".to_string(),
            self.name.clone(),
        ]];

        if self.remove_on_exit {
            commands.push(vec!["rm".to_string(), "-f".to_string(), self.name.clone()]);
        }

        commands
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{EnvVar, VolumeMount};

    // -----------------------------------------------------------------------
    // build_docker_run_args
    // -----------------------------------------------------------------------

    #[test]
    fn build_docker_run_args_minimal_config() {
        let config = DockerConfig {
            image: "ubuntu:22.04".to_string(),
            ..Default::default()
        };
        let args = build_docker_run_args(&config);
        assert_eq!(args, vec!["ubuntu:22.04"]);
    }

    #[test]
    fn build_docker_run_args_with_env_vars() {
        let config = DockerConfig {
            image: "alpine".to_string(),
            env_vars: vec![
                EnvVar {
                    key: "FOO".to_string(),
                    value: "bar".to_string(),
                },
                EnvVar {
                    key: "BAZ".to_string(),
                    value: "qux".to_string(),
                },
            ],
            ..Default::default()
        };
        let args = build_docker_run_args(&config);
        assert_eq!(args, vec!["-e", "FOO=bar", "-e", "BAZ=qux", "alpine"]);
    }

    #[test]
    fn build_docker_run_args_with_volumes_rw() {
        let config = DockerConfig {
            image: "nginx".to_string(),
            volumes: vec![VolumeMount {
                host_path: "/host/data".to_string(),
                container_path: "/data".to_string(),
                read_only: false,
            }],
            ..Default::default()
        };
        let args = build_docker_run_args(&config);
        assert_eq!(args, vec!["-v", "/host/data:/data", "nginx"]);
    }

    #[test]
    fn build_docker_run_args_with_volumes_ro() {
        let config = DockerConfig {
            image: "nginx".to_string(),
            volumes: vec![VolumeMount {
                host_path: "/host/config".to_string(),
                container_path: "/etc/nginx".to_string(),
                read_only: true,
            }],
            ..Default::default()
        };
        let args = build_docker_run_args(&config);
        assert_eq!(args, vec!["-v", "/host/config:/etc/nginx:ro", "nginx"]);
    }

    #[test]
    fn build_docker_run_args_with_working_directory() {
        let config = DockerConfig {
            image: "node:18".to_string(),
            working_directory: Some("/app".to_string()),
            ..Default::default()
        };
        let args = build_docker_run_args(&config);
        assert_eq!(args, vec!["-w", "/app", "node:18"]);
    }

    #[test]
    fn build_docker_run_args_with_shell() {
        let config = DockerConfig {
            image: "alpine".to_string(),
            shell: Some("/bin/sh".to_string()),
            ..Default::default()
        };
        let args = build_docker_run_args(&config);
        assert_eq!(args, vec!["alpine", "/bin/sh"]);
    }

    #[test]
    fn build_docker_run_args_all_options() {
        let config = DockerConfig {
            image: "ubuntu:22.04".to_string(),
            shell: Some("/bin/bash".to_string()),
            env_vars: vec![EnvVar {
                key: "TERM".to_string(),
                value: "xterm-256color".to_string(),
            }],
            volumes: vec![
                VolumeMount {
                    host_path: "/tmp".to_string(),
                    container_path: "/mnt/tmp".to_string(),
                    read_only: false,
                },
                VolumeMount {
                    host_path: "/etc/hosts".to_string(),
                    container_path: "/etc/hosts".to_string(),
                    read_only: true,
                },
            ],
            working_directory: Some("/workspace".to_string()),
            ..Default::default()
        };
        let args = build_docker_run_args(&config);
        assert_eq!(
            args,
            vec![
                "-e",
                "TERM=xterm-256color",
                "-v",
                "/tmp:/mnt/tmp",
                "-v",
                "/etc/hosts:/etc/hosts:ro",
                "-w",
                "/workspace",
                "ubuntu:22.04",
                "/bin/bash",
            ]
        );
    }

    #[test]
    fn build_docker_run_args_empty_working_directory_skipped() {
        let config = DockerConfig {
            image: "alpine".to_string(),
            working_directory: Some(String::new()),
            ..Default::default()
        };
        let args = build_docker_run_args(&config);
        assert_eq!(args, vec!["alpine"]);
    }

    #[test]
    fn build_docker_run_args_empty_shell_skipped() {
        let config = DockerConfig {
            image: "alpine".to_string(),
            shell: Some(String::new()),
            ..Default::default()
        };
        let args = build_docker_run_args(&config);
        assert_eq!(args, vec!["alpine"]);
    }

    // -----------------------------------------------------------------------
    // build_docker_exec_args
    // -----------------------------------------------------------------------

    #[test]
    fn build_docker_exec_args_produces_correct_output() {
        let args = build_docker_exec_args("my-container", "/bin/bash");
        assert_eq!(args, vec!["exec", "-it", "my-container", "/bin/bash"]);
    }

    // -----------------------------------------------------------------------
    // validate_docker_config
    // -----------------------------------------------------------------------

    #[test]
    fn validate_docker_config_valid() {
        let config = DockerConfig {
            image: "ubuntu:22.04".to_string(),
            env_vars: vec![EnvVar {
                key: "FOO".to_string(),
                value: "bar".to_string(),
            }],
            volumes: vec![VolumeMount {
                host_path: "/host".to_string(),
                container_path: "/container".to_string(),
                read_only: false,
            }],
            ..Default::default()
        };
        assert!(validate_docker_config(&config).is_ok());
    }

    #[test]
    fn validate_docker_config_empty_image() {
        let config = DockerConfig {
            image: String::new(),
            ..Default::default()
        };
        let err = validate_docker_config(&config).unwrap_err();
        assert!(
            err.to_string().contains("Docker image must not be empty"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn validate_docker_config_empty_env_var_key() {
        let config = DockerConfig {
            image: "alpine".to_string(),
            env_vars: vec![EnvVar {
                key: String::new(),
                value: "val".to_string(),
            }],
            ..Default::default()
        };
        let err = validate_docker_config(&config).unwrap_err();
        assert!(
            err.to_string()
                .contains("Environment variable key must not be empty"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn validate_docker_config_empty_volume_host_path() {
        let config = DockerConfig {
            image: "alpine".to_string(),
            volumes: vec![VolumeMount {
                host_path: String::new(),
                container_path: "/data".to_string(),
                read_only: false,
            }],
            ..Default::default()
        };
        let err = validate_docker_config(&config).unwrap_err();
        assert!(
            err.to_string()
                .contains("Volume host path must not be empty"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn validate_docker_config_empty_volume_container_path() {
        let config = DockerConfig {
            image: "alpine".to_string(),
            volumes: vec![VolumeMount {
                host_path: "/host".to_string(),
                container_path: String::new(),
                read_only: false,
            }],
            ..Default::default()
        };
        let err = validate_docker_config(&config).unwrap_err();
        assert!(
            err.to_string()
                .contains("Volume container path must not be empty"),
            "unexpected error: {err}"
        );
    }

    // -----------------------------------------------------------------------
    // DockerContainer
    // -----------------------------------------------------------------------

    #[test]
    fn docker_container_is_running_command() {
        let container = DockerContainer::new("test-ctr".to_string(), "alpine".to_string(), true);
        let args = container.is_running_command();
        assert_eq!(
            args,
            vec!["inspect", "-f", "{{.State.Running}}", "test-ctr"]
        );
    }

    #[test]
    fn docker_container_cleanup_args_with_remove() {
        let container = DockerContainer::new("test-ctr".to_string(), "alpine".to_string(), true);
        let commands = container.cleanup_args();
        assert_eq!(commands.len(), 2);
        assert_eq!(commands[0], vec!["stop", "-t", "5", "test-ctr"]);
        assert_eq!(commands[1], vec!["rm", "-f", "test-ctr"]);
    }

    #[test]
    fn docker_container_cleanup_args_without_remove() {
        let container = DockerContainer::new("test-ctr".to_string(), "alpine".to_string(), false);
        let commands = container.cleanup_args();
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0], vec!["stop", "-t", "5", "test-ctr"]);
    }
}
