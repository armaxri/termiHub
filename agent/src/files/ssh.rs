//! SFTP relay for SSH jump host targets.
//!
//! Opens a dedicated SSH/SFTP connection to the target host
//! (using the connection's SSH config) and relays file operations.

use std::io::{Read, Write};
use std::net::TcpStream;

use ssh2::{Session, Sftp};

use crate::protocol::methods::{FileEntry, FilesStatResult, SshSessionConfig};

use super::{chrono_from_epoch, format_permissions, FileBackend, FileError};

/// SFTP file backend for connections through SSH jump hosts.
///
/// Creates a fresh SFTP connection per operation using the stored SSH config.
pub struct SshFileBackend {
    config: SshSessionConfig,
}

struct SftpConnection {
    _session: Session,
    sftp: Sftp,
}

// ssh2::Sftp and ssh2::Session contain raw pointers but are safe to send
// between threads when protected by a Mutex.
unsafe impl Send for SftpConnection {}
unsafe impl Sync for SftpConnection {}

impl SshFileBackend {
    pub fn new(config: SshSessionConfig) -> Self {
        Self { config }
    }
}

#[async_trait::async_trait]
impl FileBackend for SshFileBackend {
    async fn list(&self, path: &str) -> Result<Vec<FileEntry>, FileError> {
        let config = self.config.clone();
        let path = path.to_string();
        // We can't easily share the Mutex-protected connection across spawn_blocking
        // boundaries, so we create a fresh connection per call. This is acceptable
        // for file browsing which is not high-frequency.
        tokio::task::spawn_blocking(move || {
            let conn = connect_sftp(&config)?;
            sftp_list_dir(&conn.sftp, &path)
        })
        .await
        .map_err(|e| FileError::OperationFailed(e.to_string()))?
    }

    async fn read(&self, path: &str) -> Result<Vec<u8>, FileError> {
        let config = self.config.clone();
        let path = path.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = connect_sftp(&config)?;
            sftp_read_file(&conn.sftp, &path)
        })
        .await
        .map_err(|e| FileError::OperationFailed(e.to_string()))?
    }

    async fn write(&self, path: &str, data: &[u8]) -> Result<(), FileError> {
        let config = self.config.clone();
        let path = path.to_string();
        let data = data.to_vec();
        tokio::task::spawn_blocking(move || {
            let conn = connect_sftp(&config)?;
            sftp_write_file(&conn.sftp, &path, &data)
        })
        .await
        .map_err(|e| FileError::OperationFailed(e.to_string()))?
    }

    async fn delete(&self, path: &str, is_directory: bool) -> Result<(), FileError> {
        let config = self.config.clone();
        let path = path.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = connect_sftp(&config)?;
            if is_directory {
                conn.sftp
                    .rmdir(std::path::Path::new(&path))
                    .map_err(|e| map_ssh_error(e, &path))
            } else {
                conn.sftp
                    .unlink(std::path::Path::new(&path))
                    .map_err(|e| map_ssh_error(e, &path))
            }
        })
        .await
        .map_err(|e| FileError::OperationFailed(e.to_string()))?
    }

    async fn rename(&self, old_path: &str, new_path: &str) -> Result<(), FileError> {
        let config = self.config.clone();
        let old = old_path.to_string();
        let new = new_path.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = connect_sftp(&config)?;
            conn.sftp
                .rename(
                    std::path::Path::new(&old),
                    std::path::Path::new(&new),
                    None,
                )
                .map_err(|e| map_ssh_error(e, &old))
        })
        .await
        .map_err(|e| FileError::OperationFailed(e.to_string()))?
    }

    async fn stat(&self, path: &str) -> Result<FilesStatResult, FileError> {
        let config = self.config.clone();
        let path = path.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = connect_sftp(&config)?;
            sftp_stat(&conn.sftp, &path)
        })
        .await
        .map_err(|e| FileError::OperationFailed(e.to_string()))?
    }
}

/// Establish an SSH connection and open the SFTP subsystem.
fn connect_sftp(config: &SshSessionConfig) -> Result<SftpConnection, FileError> {
    let port = config.port.unwrap_or(22);
    let addr = format!("{}:{}", config.host, port);

    let tcp = TcpStream::connect(&addr)
        .map_err(|e| FileError::OperationFailed(format!("TCP connect to {addr} failed: {e}")))?;

    let mut session = Session::new()
        .map_err(|e| FileError::OperationFailed(format!("Failed to create SSH session: {e}")))?;
    session.set_tcp_stream(tcp);
    session
        .handshake()
        .map_err(|e| FileError::OperationFailed(format!("SSH handshake failed: {e}")))?;

    // Authenticate based on method
    match config.auth_method.as_str() {
        "key" => {
            let key_path = config.key_path.as_deref().unwrap_or("~/.ssh/id_rsa");
            let expanded = shellexpand::tilde(key_path);
            session
                .userauth_pubkey_file(&config.username, None, std::path::Path::new(expanded.as_ref()), None)
                .map_err(|e| {
                    FileError::OperationFailed(format!("SSH key auth failed: {e}"))
                })?;
        }
        "password" => {
            let password = config.password.as_deref().unwrap_or("");
            session
                .userauth_password(&config.username, password)
                .map_err(|e| {
                    FileError::OperationFailed(format!("SSH password auth failed: {e}"))
                })?;
        }
        "agent" => {
            session
                .userauth_agent(&config.username)
                .map_err(|e| {
                    FileError::OperationFailed(format!("SSH agent auth failed: {e}"))
                })?;
        }
        other => {
            return Err(FileError::OperationFailed(format!(
                "Unknown SSH auth method: {other}"
            )));
        }
    }

    if !session.authenticated() {
        return Err(FileError::OperationFailed(
            "SSH authentication failed".to_string(),
        ));
    }

    let sftp = session
        .sftp()
        .map_err(|e| FileError::OperationFailed(format!("Failed to open SFTP session: {e}")))?;

    Ok(SftpConnection {
        _session: session,
        sftp,
    })
}

/// List directory contents via SFTP.
fn sftp_list_dir(sftp: &Sftp, path: &str) -> Result<Vec<FileEntry>, FileError> {
    let entries = sftp
        .readdir(std::path::Path::new(path))
        .map_err(|e| map_ssh_error(e, path))?;

    let parent = if path.ends_with('/') {
        path.to_string()
    } else {
        format!("{}/", path)
    };

    let mut result = Vec::new();
    for (pathbuf, stat) in entries {
        let name = pathbuf
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        if name == "." || name == ".." {
            continue;
        }

        let is_directory = stat.is_dir();
        let size = stat.size.unwrap_or(0);
        let modified = stat
            .mtime
            .map(|t| chrono_from_epoch(t))
            .unwrap_or_default();
        let permissions = stat.perm.map(|p| format_permissions(p & 0o777));
        let full_path = format!("{}{}", parent, name);

        result.push(FileEntry {
            name,
            path: full_path,
            is_directory,
            size,
            modified,
            permissions,
        });
    }

    Ok(result)
}

/// Read a file via SFTP.
fn sftp_read_file(sftp: &Sftp, path: &str) -> Result<Vec<u8>, FileError> {
    let mut file = sftp
        .open(std::path::Path::new(path))
        .map_err(|e| map_ssh_error(e, path))?;

    let mut data = Vec::new();
    file.read_to_end(&mut data)
        .map_err(|e| FileError::OperationFailed(format!("{path}: {e}")))?;

    Ok(data)
}

/// Write a file via SFTP.
fn sftp_write_file(sftp: &Sftp, path: &str, data: &[u8]) -> Result<(), FileError> {
    let mut file = sftp
        .create(std::path::Path::new(path))
        .map_err(|e| map_ssh_error(e, path))?;

    file.write_all(data)
        .map_err(|e| FileError::OperationFailed(format!("{path}: {e}")))?;

    Ok(())
}

/// Stat a single file/directory via SFTP.
fn sftp_stat(sftp: &Sftp, path: &str) -> Result<FilesStatResult, FileError> {
    let stat = sftp
        .stat(std::path::Path::new(path))
        .map_err(|e| map_ssh_error(e, path))?;

    let name = std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());

    Ok(FilesStatResult {
        name,
        path: path.to_string(),
        is_directory: stat.is_dir(),
        size: stat.size.unwrap_or(0),
        modified: stat
            .mtime
            .map(|t| chrono_from_epoch(t))
            .unwrap_or_default(),
        permissions: stat.perm.map(|p| format_permissions(p & 0o777)),
    })
}

/// Map ssh2 errors to FileError.
fn map_ssh_error(e: ssh2::Error, path: &str) -> FileError {
    let msg = e.message();
    // SFTP error codes: SSH_FX_NO_SUCH_FILE = 2, SSH_FX_PERMISSION_DENIED = 3
    match e.code() {
        ssh2::ErrorCode::SFTP(2) => FileError::NotFound(path.to_string()),
        ssh2::ErrorCode::SFTP(3) => FileError::PermissionDenied(path.to_string()),
        _ => FileError::OperationFailed(format!("{path}: {msg}")),
    }
}
