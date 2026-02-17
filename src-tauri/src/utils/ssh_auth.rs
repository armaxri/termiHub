use std::net::TcpStream;

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
            let key_path_str = config.key_path.as_deref().unwrap_or("~/.ssh/id_rsa");
            let key_path = std::path::PathBuf::from(shellexpand(key_path_str));
            let passphrase = config.password.as_deref();

            // Convert OpenSSH-format keys (e.g. Ed25519) to PEM for libssh2
            let prepared = crate::utils::ssh_key_convert::prepare_key(&key_path, passphrase)?;
            let auth_path = match &prepared {
                crate::utils::ssh_key_convert::PreparedKey::Original => key_path.as_path(),
                crate::utils::ssh_key_convert::PreparedKey::Converted(temp) => temp.path(),
            };

            session
                .userauth_pubkey_file(&config.username, None, auth_path, passphrase)
                .map_err(|e| TerminalError::SshError(format!("Key auth failed: {}", e)))?;
            // `prepared` dropped here — temp file cleaned up
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

/// Expand `~` prefix in paths to the user's home directory.
pub fn shellexpand(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs_home() {
            return format!("{}/{}", home, rest);
        }
    }
    path.to_string()
}

/// Get the user's home directory from environment variables.
pub fn dirs_home() -> Option<String> {
    std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())
}
