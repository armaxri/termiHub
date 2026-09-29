//! Docker session helpers — pure-logic validation for Docker container
//! configuration.
//!
//! Provides [`validate_docker_config`], a no-I/O, no-async check run before a
//! Docker session is created. The live backend
//! ([`crate::backends::docker::Docker`]) talks to the daemon through the
//! `bollard` API, so there is no CLI-argument building here.

use crate::config::{ContainerMode, DockerConfig};
use crate::errors::SessionError;

/// A Docker Compose service target (`project/service`, #3784).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposeTarget {
    /// Compose project name (the `com.docker.compose.project` label).
    pub project: String,
    /// Compose service name (the `com.docker.compose.service` label).
    pub service: String,
}

impl std::fmt::Display for ComposeTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}", self.project, self.service)
    }
}

/// Parse a `project/service` Compose target (#3784).
///
/// Splits at the first `/`; both halves are trimmed and must be non-empty, and
/// the service must not contain another `/` (Compose names never do).
///
/// # Errors
///
/// Returns [`SessionError::InvalidConfig`] for any other shape.
pub fn parse_compose_target(value: &str) -> Result<ComposeTarget, SessionError> {
    let invalid = || {
        SessionError::InvalidConfig(format!(
            "Compose service must be given as project/service, got {:?}",
            value.trim()
        ))
    };
    let (project, service) = value.trim().split_once('/').ok_or_else(invalid)?;
    let (project, service) = (project.trim(), service.trim());
    if project.is_empty() || service.is_empty() || service.contains('/') {
        return Err(invalid());
    }
    Ok(ComposeTarget {
        project: project.to_string(),
        service: service.to_string(),
    })
}

/// Validate a [`DockerConfig`] before session creation.
///
/// Checks that the image is non-blank, every environment variable key is
/// non-blank and free of `=`, and every volume mount path (host and container)
/// is non-blank.
///
/// This is the last no-I/O gate before a session is created — the desktop
/// `connect()` path does not run the schema validator — so, like
/// [`validate_ssh_config`](crate::session::ssh::validate_ssh_config) and
/// [`parse_serial_config`](crate::session::serial::parse_serial_config) (#2349),
/// it **rejects** malformed values rather than letting them through to fail deep
/// in the runtime:
/// - Blank (whitespace-only) values are treated as empty: an image of `"   "`
///   would otherwise reach `create_image` and fail mid-pull with a confusing
///   `Failed to pull image '   '` instead of a clear up-front error.
/// - An env-var key containing `=` is rejected because the backend builds each
///   variable as `format!("{key}={value}")`; a key like `FOO=BAR` would be split
///   by the daemon at the first `=`, silently corrupting the container's
///   environment.
///
/// # Errors
///
/// Returns [`SessionError::InvalidConfig`] with a descriptive message if
/// validation fails.
pub fn validate_docker_config(config: &DockerConfig) -> Result<(), SessionError> {
    match config.container_mode {
        // Exec-into-existing (PROD-016): the image is irrelevant (no container is
        // created), but a running container must be named to target.
        ContainerMode::Existing => {
            let name = config.existing_container.as_deref().unwrap_or("").trim();
            if name.is_empty() {
                return Err(SessionError::InvalidConfig(
                    "An existing container name or ID must be provided".to_string(),
                ));
            }
        }
        // Compose service (#3784): the image is irrelevant, but the target must
        // be a well-formed `project/service`.
        ContainerMode::Compose => {
            let target = config.compose_service.as_deref().unwrap_or("").trim();
            if target.is_empty() {
                return Err(SessionError::InvalidConfig(
                    "A Compose service (project/service) must be provided".to_string(),
                ));
            }
            parse_compose_target(target)?;
        }
        // Create-and-run a new container: the image is required, as before.
        ContainerMode::New => {
            if config.image.trim().is_empty() {
                return Err(SessionError::InvalidConfig(
                    "Docker image must not be empty".to_string(),
                ));
            }
        }
    }

    for env_var in &config.env_vars {
        if env_var.key.trim().is_empty() {
            return Err(SessionError::InvalidConfig(
                "Environment variable key must not be empty".to_string(),
            ));
        }
        if env_var.key.contains('=') {
            return Err(SessionError::InvalidConfig(format!(
                "Environment variable key must not contain '=': {:?}",
                env_var.key
            )));
        }
    }

    for volume in &config.volumes {
        if volume.host_path.trim().is_empty() {
            return Err(SessionError::InvalidConfig(
                "Volume host path must not be empty".to_string(),
            ));
        }
        if volume.container_path.trim().is_empty() {
            return Err(SessionError::InvalidConfig(
                "Volume container path must not be empty".to_string(),
            ));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{ContainerMode, EnvVar, VolumeMount};

    #[test]
    fn validate_docker_config_existing_mode_requires_container_name() {
        // PROD-016: existing mode with no container name is rejected up front.
        let config = DockerConfig {
            container_mode: ContainerMode::Existing,
            existing_container: None,
            image: String::new(),
            ..Default::default()
        };
        let err = validate_docker_config(&config).unwrap_err();
        assert!(
            err.to_string()
                .contains("existing container name or ID must be provided"),
            "unexpected error: {err}"
        );

        // Whitespace-only is treated as empty.
        let config = DockerConfig {
            container_mode: ContainerMode::Existing,
            existing_container: Some("   ".to_string()),
            image: String::new(),
            ..Default::default()
        };
        assert!(validate_docker_config(&config).is_err());
    }

    #[test]
    fn validate_docker_config_existing_mode_ignores_empty_image() {
        // PROD-016: image is not required when exec-ing into an existing
        // container — only the container name matters.
        let config = DockerConfig {
            container_mode: ContainerMode::Existing,
            existing_container: Some("my-running-app".to_string()),
            image: String::new(),
            ..Default::default()
        };
        assert!(validate_docker_config(&config).is_ok());
    }

    #[test]
    fn parse_compose_target_accepts_project_slash_service() {
        let t = parse_compose_target(" shop / web ").unwrap();
        assert_eq!(
            t,
            ComposeTarget {
                project: "shop".into(),
                service: "web".into()
            }
        );
        assert_eq!(t.to_string(), "shop/web");
    }

    #[test]
    fn parse_compose_target_rejects_malformed() {
        for bad in ["", "shop", "/web", "shop/", " / ", "a/b/c"] {
            let err = parse_compose_target(bad).unwrap_err();
            assert!(
                matches!(err, SessionError::InvalidConfig(_)),
                "{bad:?} -> {err}"
            );
        }
    }

    #[test]
    fn validate_docker_config_compose_mode() {
        let with = |target: Option<&str>| DockerConfig {
            container_mode: ContainerMode::Compose,
            compose_service: target.map(str::to_string),
            image: String::new(),
            ..Default::default()
        };
        // Image is not required; a well-formed target is.
        assert!(validate_docker_config(&with(Some("shop/web"))).is_ok());
        let err = validate_docker_config(&with(None)).unwrap_err();
        assert!(err.to_string().contains("Compose service"), "{err}");
        assert!(validate_docker_config(&with(Some("  "))).is_err());
        assert!(validate_docker_config(&with(Some("web"))).is_err());
    }

    #[test]
    fn validate_docker_config_new_mode_still_requires_image() {
        // Back-compat: default (new) mode keeps requiring an image.
        let config = DockerConfig {
            container_mode: ContainerMode::New,
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
    // Whitespace-only / malformed values must be REJECTED, not silently
    // accepted (#2371 — the #2349 class). The sibling `validate_ssh_config`
    // already holds host/username/key_path to `.trim().is_empty()`; Docker
    // must match, and env-var keys must never carry a `=` (it corrupts the
    // `KEY=VALUE` env string built in backends::docker).
    // -----------------------------------------------------------------------

    #[test]
    fn validate_docker_config_whitespace_only_image() {
        let config = DockerConfig {
            image: "   ".to_string(),
            ..Default::default()
        };
        let err = validate_docker_config(&config).unwrap_err();
        assert!(
            err.to_string().contains("Docker image must not be empty"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn validate_docker_config_whitespace_only_env_var_key() {
        let config = DockerConfig {
            image: "alpine".to_string(),
            env_vars: vec![EnvVar {
                key: "   ".to_string(),
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
    fn validate_docker_config_env_var_key_with_equals() {
        let config = DockerConfig {
            image: "alpine".to_string(),
            env_vars: vec![EnvVar {
                key: "FOO=BAR".to_string(),
                value: "val".to_string(),
            }],
            ..Default::default()
        };
        let err = validate_docker_config(&config).unwrap_err();
        assert!(
            err.to_string()
                .contains("Environment variable key must not contain '='"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn validate_docker_config_whitespace_only_volume_host_path() {
        let config = DockerConfig {
            image: "alpine".to_string(),
            volumes: vec![VolumeMount {
                host_path: "   ".to_string(),
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
    fn validate_docker_config_whitespace_only_volume_container_path() {
        let config = DockerConfig {
            image: "alpine".to_string(),
            volumes: vec![VolumeMount {
                host_path: "/host".to_string(),
                container_path: "   ".to_string(),
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

    #[test]
    fn validate_docker_config_accepts_normal_env_key_with_underscore() {
        // Regression guard: the `=` check must not reject ordinary keys.
        let config = DockerConfig {
            image: "alpine".to_string(),
            env_vars: vec![EnvVar {
                key: "MY_VAR_1".to_string(),
                value: "some=value=with=equals".to_string(),
            }],
            ..Default::default()
        };
        assert!(
            validate_docker_config(&config).is_ok(),
            "a normal key with an '=' in the VALUE must still be accepted"
        );
    }
}
