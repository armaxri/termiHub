//! SSH session helpers — pure-logic SSH configuration validation with no
//! network I/O, used by the shared SSH backend (`backends::ssh`) before it
//! opens a connection.

use crate::config::SshConfig;
use crate::errors::SessionError;

/// Validate SSH config before attempting a connection.
///
/// Checks, for the target **and every `proxy_jump` hop** (#2337):
/// - `host` is not empty
/// - `username` is not empty
/// - When `auth_method` is `"key"`, `key_path` must be present and non-empty
///
/// Each jump-host hop is TCP-connected and authenticated exactly like the target
/// (see `connect_gateway_chain`),
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
