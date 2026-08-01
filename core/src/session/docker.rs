//! Docker session helpers — pure-logic validation for Docker container
//! configuration.
//!
//! Provides [`validate_docker_config`], a no-I/O, no-async check run before a
//! Docker session is created. The live backend
//! ([`crate::backends::docker::Docker`]) talks to the daemon through the
//! `bollard` API, so there is no CLI-argument building here.

use crate::config::DockerConfig;
use crate::errors::SessionError;

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{EnvVar, VolumeMount};

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
