use std::net::TcpStream;
#[cfg(not(target_os = "windows"))]
use std::path::Path;

use ssh2::Session;

use crate::terminal::backend::SshConfig;
use crate::utils::errors::TerminalError;

/// Connect to an SSH server, perform handshake, and authenticate.
///
/// Returns an authenticated `Session` in blocking mode.
pub fn connect_and_authenticate(config: &SshConfig) -> Result<Session, TerminalError> {
    let addr = format!("{}:{}", config.host, config.port);
    let tcp = TcpStream::connect(&addr)
        .map_err(|e| TerminalError::SshError(format!("Connection failed: {}", e)))?;

    let mut session = Session::new().map_err(|e| TerminalError::SshError(e.to_string()))?;

    session.set_tcp_stream(tcp);
    session
        .handshake()
        .map_err(|e| TerminalError::SshError(format!("Handshake failed: {}", e)))?;

    // Authenticate
    match config.auth_method.as_str() {
        "agent" => {
            session
                .userauth_agent(&config.username)
                .map_err(|e| TerminalError::SshError(format!("Agent auth failed: {}", e)))?;
        }
        "key" => {
            // key_path is tilde-expanded by SshConfig::expand(); apply expansion
            // to the fallback too in case key_path was None.
            let key_path_str = config
                .key_path
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or("~/.ssh/id_rsa");
            let expanded = crate::utils::expand::expand_tilde(key_path_str);
            let key_path = std::path::PathBuf::from(&expanded);
            let passphrase = config.password.as_deref();

            // Convert OpenSSH-format keys (e.g. Ed25519) to PEM for libssh2
            let prepared = crate::utils::ssh_key_convert::prepare_key(&key_path, passphrase)?;
            match prepared {
                crate::utils::ssh_key_convert::PreparedKey::Original => {
                    session
                        .userauth_pubkey_file(&config.username, None, &key_path, passphrase)
                        .map_err(|e| TerminalError::SshError(format!("Key auth failed: {}", e)))?;
                }
                crate::utils::ssh_key_convert::PreparedKey::ConvertedPem(pem_bytes) => {
                    // Use memory-based auth to avoid temp file issues on Windows.
                    // The converted key is already decrypted, so pass None for passphrase.
                    let pem_str = std::str::from_utf8(&pem_bytes).map_err(|e| {
                        TerminalError::SshError(format!("Invalid PEM encoding: {}", e))
                    })?;
                    session
                        .userauth_pubkey_memory(&config.username, None, pem_str, None)
                        .map_err(|e| TerminalError::SshError(format!("Key auth failed: {}", e)))?;
                }
            }
        }
        _ => {
            let password = config.password.as_deref().unwrap_or("");
            session
                .userauth_password(&config.username, password)
                .map_err(|e| TerminalError::SshError(format!("Password auth failed: {}", e)))?;
        }
    }

    if !session.authenticated() {
        return Err(TerminalError::SshError("Authentication failed".to_string()));
    }

    Ok(session)
}

/// Check whether the SSH agent is running, stopped, or not installed.
///
/// - **Windows**: tries to open the `openssh-ssh-agent` named pipe.
///   `Path::exists()` does not work for named pipes, so we attempt
///   an actual open — any result other than "not found" means the
///   agent is running.
/// - **Unix**: checks if `SSH_AUTH_SOCK` is set and the socket file exists.
///
/// Returns `"running"` or `"stopped"`.
pub fn check_ssh_agent_status() -> String {
    #[cfg(target_os = "windows")]
    {
        use std::fs::OpenOptions;
        let pipe_path = r"\\.\pipe\openssh-ssh-agent";
        match OpenOptions::new().read(true).open(pipe_path) {
            Ok(_) => "running".to_string(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => "stopped".to_string(),
            // Any other error (e.g. access denied, busy) means the pipe exists
            Err(_) => "running".to_string(),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        match std::env::var("SSH_AUTH_SOCK") {
            Ok(sock_path) if !sock_path.is_empty() => {
                if Path::new(&sock_path).exists() {
                    "running".to_string()
                } else {
                    "stopped".to_string()
                }
            }
            _ => "stopped".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_ssh_agent_status_returns_valid_value() {
        let status = check_ssh_agent_status();
        assert!(
            status == "running" || status == "stopped" || status == "not_installed",
            "unexpected status: {status}"
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn check_ssh_agent_status_stopped_when_sock_unset() {
        // Temporarily remove SSH_AUTH_SOCK to test the "stopped" path
        let orig = std::env::var("SSH_AUTH_SOCK").ok();
        std::env::remove_var("SSH_AUTH_SOCK");

        let status = check_ssh_agent_status();
        assert_eq!(status, "stopped");

        // Restore original value
        if let Some(val) = orig {
            std::env::set_var("SSH_AUTH_SOCK", val);
        }
    }
}
