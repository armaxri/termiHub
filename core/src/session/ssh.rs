//! SSH session helpers — pure-logic functions for SSH command-line argument
//! building and configuration validation.
//!
//! These functions extract duplicated SSH-setup logic from the agent
//! (`ssh/backend.rs`) and provide shared, testable pure functions
//! with no network I/O.

use crate::config::SshConfig;
use crate::errors::SessionError;

/// Default SSH port. Arguments are only generated for non-default ports.
const DEFAULT_SSH_PORT: u16 = 22;

/// Build SSH command-line arguments from config.
///
/// Used by the agent's daemon approach (primary) and potentially by the
/// desktop as a CLI fallback when the `ssh2` channel approach fails.
///
/// Produces arguments for the `ssh` binary:
/// - `-tt` for forced TTY allocation
/// - `-o ServerAliveInterval=30` and `-o ServerAliveCountMax=3` for keepalive
/// - `-p <port>` when port differs from the default (22)
/// - `-i <key_path>` when auth method is `"key"` and a key path is provided
/// - `user@host` destination
/// - Optional remote shell command
pub fn build_ssh_args(config: &SshConfig) -> Vec<String> {
    let mut args = vec![
        // Force TTY allocation for interactive use
        "-tt".to_string(),
        // Keep-alive to detect dead connections
        "-o".to_string(),
        "ServerAliveInterval=30".to_string(),
        "-o".to_string(),
        "ServerAliveCountMax=3".to_string(),
    ];

    // Port (only when non-default)
    if config.port != DEFAULT_SSH_PORT {
        args.push("-p".to_string());
        args.push(config.port.to_string());
    }

    // Key-based auth
    if config.auth_method == "key" {
        if let Some(ref key_path) = config.key_path {
            args.push("-i".to_string());
            args.push(key_path.clone());
        }
    }

    // Destination: user@host
    args.push(format!("{}@{}", config.username, config.host));

    // Optional remote shell command
    if let Some(ref shell) = config.shell {
        args.push(shell.clone());
    }

    args
}

/// Validate SSH config before attempting a connection.
///
/// Checks, for the target **and every `proxy_jump` hop** (#2337):
/// - `host` is not empty
/// - `username` is not empty
/// - When `auth_method` is `"key"`, `key_path` must be present and non-empty
///
/// Each jump-host hop is TCP-connected and authenticated exactly like the target
/// (see [`connect_gateway_chain`](crate::backends::ssh::jump_host::connect_gateway_chain)),
/// so a misconfigured bastion is held to the same bar here — rejected up front
/// with a hop-identifying error instead of failing with a confusing low-level
/// connect/auth error mid-chain, or (for a `key` hop with no key) silently
/// falling back to `~/.ssh/id_rsa` in the auth path.
pub fn validate_ssh_config(config: &SshConfig) -> Result<(), SessionError> {
    // Target: `None` context keeps the original error messages byte-stable.
    validate_connection_identity(config, None)?;

    for (idx, hop) in config.proxy_jump.iter().enumerate() {
        let label = format!("jump host {} ({}:{})", idx + 1, hop.host, hop.port);
        validate_connection_identity(&hop.to_ssh_config(), Some(&label))?;
    }

    Ok(())
}

/// Validate the host / username / key-path of a single SSH connection identity —
/// the target (`context == None`) or one jump-host hop (`context == Some(label)`,
/// which prefixes each error so the user sees which hop is at fault). Shared by
/// [`validate_ssh_config`] so a hop is held to the same bar as the target.
fn validate_connection_identity(
    config: &SshConfig,
    context: Option<&str>,
) -> Result<(), SessionError> {
    let err = |msg: &str| {
        let message = match context {
            Some(label) => format!("{label}: {msg}"),
            None => msg.to_string(),
        };
        SessionError::InvalidConfig(message)
    };

    if config.host.trim().is_empty() {
        return Err(err("SSH host must not be empty"));
    }

    if config.username.trim().is_empty() {
        return Err(err("SSH username must not be empty"));
    }

    if config.auth_method == "key" {
        match &config.key_path {
            None => {
                return Err(err("SSH key path is required when auth method is \"key\""));
            }
            Some(path) if path.trim().is_empty() => {
                return Err(err(
                    "SSH key path must not be empty when auth method is \"key\"",
                ));
            }
            Some(_) => {}
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // build_ssh_args
    // -----------------------------------------------------------------------

    #[test]
    fn build_ssh_args_minimal() {
        let config = SshConfig {
            host: "build.internal".into(),
            username: "dev".into(),
            auth_method: "agent".into(),
            ..Default::default()
        };
        let args = build_ssh_args(&config);
        assert_eq!(
            args,
            vec![
                "-tt",
                "-o",
                "ServerAliveInterval=30",
                "-o",
                "ServerAliveCountMax=3",
                "dev@build.internal",
            ]
        );
    }

    #[test]
    fn build_ssh_args_with_custom_port() {
        let config = SshConfig {
            host: "example.com".into(),
            username: "user".into(),
            auth_method: "password".into(),
            port: 2222,
            ..Default::default()
        };
        let args = build_ssh_args(&config);
        assert!(args.contains(&"-p".to_string()));
        assert!(args.contains(&"2222".to_string()));
        assert!(args.contains(&"user@example.com".to_string()));
    }

    #[test]
    fn build_ssh_args_default_port_omitted() {
        let config = SshConfig {
            host: "example.com".into(),
            username: "user".into(),
            auth_method: "password".into(),
            port: 22,
            ..Default::default()
        };
        let args = build_ssh_args(&config);
        assert!(!args.contains(&"-p".to_string()));
    }

    #[test]
    fn build_ssh_args_with_key_auth() {
        let config = SshConfig {
            host: "10.0.0.5".into(),
            username: "deploy".into(),
            auth_method: "key".into(),
            key_path: Some("/home/user/.ssh/id_ed25519".into()),
            ..Default::default()
        };
        let args = build_ssh_args(&config);
        assert!(args.contains(&"-i".to_string()));
        assert!(args.contains(&"/home/user/.ssh/id_ed25519".to_string()));
    }

    #[test]
    fn build_ssh_args_password_auth_ignores_key_path() {
        let config = SshConfig {
            host: "server.example.com".into(),
            username: "admin".into(),
            auth_method: "password".into(),
            key_path: Some("/some/key".into()),
            ..Default::default()
        };
        let args = build_ssh_args(&config);
        // password auth should NOT add -i even when key_path is present
        assert!(!args.contains(&"-i".to_string()));
        assert!(args.contains(&"admin@server.example.com".to_string()));
    }

    #[test]
    fn build_ssh_args_with_shell() {
        let config = SshConfig {
            host: "example.com".into(),
            username: "user".into(),
            auth_method: "agent".into(),
            shell: Some("/bin/bash".into()),
            ..Default::default()
        };
        let args = build_ssh_args(&config);
        assert_eq!(args.last(), Some(&"/bin/bash".to_string()));
    }

    #[test]
    fn build_ssh_args_full() {
        let config = SshConfig {
            host: "10.0.0.5".into(),
            username: "deploy".into(),
            auth_method: "key".into(),
            port: 2222,
            key_path: Some("/home/user/.ssh/id_ed25519".into()),
            shell: Some("/bin/bash".into()),
            ..Default::default()
        };
        let args = build_ssh_args(&config);
        assert_eq!(
            args,
            vec![
                "-tt",
                "-o",
                "ServerAliveInterval=30",
                "-o",
                "ServerAliveCountMax=3",
                "-p",
                "2222",
                "-i",
                "/home/user/.ssh/id_ed25519",
                "deploy@10.0.0.5",
                "/bin/bash",
            ]
        );
    }

    #[test]
    fn build_ssh_args_key_auth_without_key_path() {
        let config = SshConfig {
            host: "example.com".into(),
            username: "user".into(),
            auth_method: "key".into(),
            key_path: None,
            ..Default::default()
        };
        let args = build_ssh_args(&config);
        // No -i flag when key_path is None
        assert!(!args.contains(&"-i".to_string()));
    }

    // -----------------------------------------------------------------------
    // validate_ssh_config
    // -----------------------------------------------------------------------

    #[test]
    fn validate_valid_password_config() {
        let config = SshConfig {
            host: "example.com".into(),
            username: "admin".into(),
            auth_method: "password".into(),
            password: Some("secret".into()),
            ..Default::default()
        };
        assert!(validate_ssh_config(&config).is_ok());
    }

    #[test]
    fn validate_valid_key_config() {
        let config = SshConfig {
            host: "example.com".into(),
            username: "admin".into(),
            auth_method: "key".into(),
            key_path: Some("/home/admin/.ssh/id_rsa".into()),
            ..Default::default()
        };
        assert!(validate_ssh_config(&config).is_ok());
    }

    #[test]
    fn validate_valid_agent_config() {
        let config = SshConfig {
            host: "example.com".into(),
            username: "admin".into(),
            auth_method: "agent".into(),
            ..Default::default()
        };
        assert!(validate_ssh_config(&config).is_ok());
    }

    #[test]
    fn validate_missing_host() {
        let config = SshConfig {
            host: "".into(),
            username: "admin".into(),
            auth_method: "password".into(),
            ..Default::default()
        };
        let err = validate_ssh_config(&config).unwrap_err();
        assert!(err.to_string().contains("host"));
    }

    #[test]
    fn validate_whitespace_only_host() {
        let config = SshConfig {
            host: "   ".into(),
            username: "admin".into(),
            auth_method: "password".into(),
            ..Default::default()
        };
        let err = validate_ssh_config(&config).unwrap_err();
        assert!(err.to_string().contains("host"));
    }

    #[test]
    fn validate_missing_username() {
        let config = SshConfig {
            host: "example.com".into(),
            username: "".into(),
            auth_method: "password".into(),
            ..Default::default()
        };
        let err = validate_ssh_config(&config).unwrap_err();
        assert!(err.to_string().contains("username"));
    }

    #[test]
    fn validate_whitespace_only_username() {
        let config = SshConfig {
            host: "example.com".into(),
            username: "  ".into(),
            auth_method: "password".into(),
            ..Default::default()
        };
        let err = validate_ssh_config(&config).unwrap_err();
        assert!(err.to_string().contains("username"));
    }

    #[test]
    fn validate_key_auth_missing_key_path() {
        let config = SshConfig {
            host: "example.com".into(),
            username: "admin".into(),
            auth_method: "key".into(),
            key_path: None,
            ..Default::default()
        };
        let err = validate_ssh_config(&config).unwrap_err();
        assert!(err.to_string().contains("key path"));
    }

    #[test]
    fn validate_key_auth_empty_key_path() {
        let config = SshConfig {
            host: "example.com".into(),
            username: "admin".into(),
            auth_method: "key".into(),
            key_path: Some("".into()),
            ..Default::default()
        };
        let err = validate_ssh_config(&config).unwrap_err();
        assert!(err.to_string().contains("key path"));
    }

    #[test]
    fn validate_key_auth_whitespace_key_path() {
        let config = SshConfig {
            host: "example.com".into(),
            username: "admin".into(),
            auth_method: "key".into(),
            key_path: Some("   ".into()),
            ..Default::default()
        };
        let err = validate_ssh_config(&config).unwrap_err();
        assert!(err.to_string().contains("key path"));
    }

    // -----------------------------------------------------------------------
    // validate_ssh_config — proxy_jump hops (#2337)
    // -----------------------------------------------------------------------

    use crate::config::JumpHostConfig;

    /// A minimal, valid jump-host hop for building chains in the tests below.
    fn jump_hop(host: &str, username: &str, auth_method: &str) -> JumpHostConfig {
        JumpHostConfig {
            host: host.into(),
            port: 22,
            username: username.into(),
            auth_method: auth_method.into(),
            ..Default::default()
        }
    }

    fn target_with_hops(hops: Vec<JumpHostConfig>) -> SshConfig {
        SshConfig {
            host: "target.example.com".into(),
            username: "admin".into(),
            auth_method: "agent".into(),
            proxy_jump: hops,
            ..Default::default()
        }
    }

    #[test]
    fn validate_accepts_valid_single_hop() {
        let config = target_with_hops(vec![jump_hop("bastion", "jump", "agent")]);
        assert!(validate_ssh_config(&config).is_ok());
    }

    #[test]
    fn validate_accepts_valid_multi_hop_chain() {
        let config = target_with_hops(vec![
            jump_hop("edge", "u", "agent"),
            JumpHostConfig {
                key_path: Some("/home/u/.ssh/id_ed25519".into()),
                ..jump_hop("bastion", "u", "key")
            },
        ]);
        assert!(validate_ssh_config(&config).is_ok());
    }

    #[test]
    fn validate_rejects_hop_with_empty_host() {
        let config = target_with_hops(vec![jump_hop("", "jump", "agent")]);
        let err = validate_ssh_config(&config).unwrap_err().to_string();
        assert!(err.contains("host"), "unexpected: {err}");
        assert!(err.contains("jump host 1"), "should name the hop: {err}");
    }

    #[test]
    fn validate_rejects_hop_with_whitespace_username() {
        let config = target_with_hops(vec![jump_hop("bastion", "   ", "agent")]);
        let err = validate_ssh_config(&config).unwrap_err().to_string();
        assert!(err.contains("username"), "unexpected: {err}");
        assert!(err.contains("jump host 1"), "should name the hop: {err}");
    }

    #[test]
    fn validate_rejects_key_auth_hop_without_key_path() {
        // The security-adjacent case: a key-auth hop with no key selected would
        // otherwise silently fall back to ~/.ssh/id_rsa in auth.rs.
        let config = target_with_hops(vec![jump_hop("bastion", "jump", "key")]);
        let err = validate_ssh_config(&config).unwrap_err().to_string();
        assert!(err.contains("key path"), "unexpected: {err}");
        assert!(err.contains("jump host 1"), "should name the hop: {err}");
    }

    #[test]
    fn validate_rejects_key_auth_hop_with_empty_key_path() {
        let config = target_with_hops(vec![JumpHostConfig {
            key_path: Some("  ".into()),
            ..jump_hop("bastion", "jump", "key")
        }]);
        let err = validate_ssh_config(&config).unwrap_err().to_string();
        assert!(err.contains("key path"), "unexpected: {err}");
    }

    #[test]
    fn validate_names_the_offending_hop_in_a_chain() {
        // First hop is fine; the second is invalid — the error must point at hop 2.
        let config = target_with_hops(vec![
            jump_hop("edge", "u", "agent"),
            jump_hop("", "u", "agent"),
        ]);
        let err = validate_ssh_config(&config).unwrap_err().to_string();
        assert!(err.contains("jump host 2"), "should name hop 2: {err}");
    }

    #[test]
    fn validate_still_accepts_direct_target_without_hops() {
        // A regression guard: adding hop validation must not change the
        // no-jump-host path.
        let config = target_with_hops(vec![]);
        assert!(validate_ssh_config(&config).is_ok());
    }
}
