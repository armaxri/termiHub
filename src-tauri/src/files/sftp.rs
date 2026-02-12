use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use ssh2::{Session, Sftp};

use super::FileEntry;
use super::utils::{chrono_from_epoch, format_permissions};
use crate::terminal::backend::SshConfig;
use crate::utils::errors::TerminalError;
use crate::utils::ssh_auth::connect_and_authenticate;

/// An SFTP session wrapping a dedicated SSH connection.
///
/// Uses blocking mode — each SFTP session opens its own SSH connection
/// to avoid conflicts with the terminal session's non-blocking mode.
pub struct SftpSession {
    _session: Session,
    sftp: Sftp,
}

impl SftpSession {
    /// Open a new SFTP session to the given SSH host.
    pub fn new(config: &SshConfig) -> Result<Self, TerminalError> {
        let session = connect_and_authenticate(config)?;
        // Keep blocking mode for SFTP operations
        session.set_blocking(true);

        let sftp = session
            .sftp()
            .map_err(|e| TerminalError::SshError(format!("SFTP init failed: {}", e)))?;

        Ok(Self {
            _session: session,
            sftp,
        })
    }

    /// List directory contents, filtering out `.` and `..`.
    pub fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, TerminalError> {
        let dir = std::path::Path::new(path);
        let entries = self
            .sftp
            .readdir(dir)
            .map_err(|e| TerminalError::SshError(format!("readdir failed: {}", e)))?;

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
                .map(|t| {
                    chrono_from_epoch(t)
                })
                .unwrap_or_default();
            let permissions = stat.perm.map(format_permissions);

            result.push(FileEntry {
                name,
                path: pathbuf.to_string_lossy().to_string(),
                is_directory,
                size,
                modified,
                permissions,
            });
        }

        Ok(result)
    }

    /// Download a remote file to a local path. Returns bytes written.
    pub fn read_file(
        &self,
        remote_path: &str,
        local_path: &str,
    ) -> Result<u64, TerminalError> {
        let remote = std::path::Path::new(remote_path);
        let mut remote_file = self
            .sftp
            .open(remote)
            .map_err(|e| TerminalError::SshError(format!("open remote file failed: {}", e)))?;

        let mut local_file = std::fs::File::create(local_path)
            .map_err(|e| TerminalError::SshError(format!("create local file failed: {}", e)))?;

        let mut buf = [0u8; 32768];
        let mut total: u64 = 0;
        loop {
            let n = remote_file
                .read(&mut buf)
                .map_err(|e| TerminalError::SshError(format!("read failed: {}", e)))?;
            if n == 0 {
                break;
            }
            local_file
                .write_all(&buf[..n])
                .map_err(|e| TerminalError::SshError(format!("write failed: {}", e)))?;
            total += n as u64;
        }

        Ok(total)
    }

    /// Upload a local file to a remote path. Returns bytes written.
    pub fn write_file(
        &self,
        local_path: &str,
        remote_path: &str,
    ) -> Result<u64, TerminalError> {
        let remote = std::path::Path::new(remote_path);
        let mut remote_file = self
            .sftp
            .create(remote)
            .map_err(|e| TerminalError::SshError(format!("create remote file failed: {}", e)))?;

        let mut local_file = std::fs::File::open(local_path)
            .map_err(|e| TerminalError::SshError(format!("open local file failed: {}", e)))?;

        let mut buf = [0u8; 32768];
        let mut total: u64 = 0;
        loop {
            let n = local_file
                .read(&mut buf)
                .map_err(|e| TerminalError::SshError(format!("read failed: {}", e)))?;
            if n == 0 {
                break;
            }
            remote_file
                .write_all(&buf[..n])
                .map_err(|e| TerminalError::SshError(format!("write failed: {}", e)))?;
            total += n as u64;
        }

        Ok(total)
    }

    /// Create a directory on the remote host.
    pub fn mkdir(&self, path: &str) -> Result<(), TerminalError> {
        let dir = std::path::Path::new(path);
        self.sftp
            .mkdir(dir, 0o755)
            .map_err(|e| TerminalError::SshError(format!("mkdir failed: {}", e)))
    }

    /// Remove a file on the remote host.
    pub fn remove_file(&self, path: &str) -> Result<(), TerminalError> {
        let file = std::path::Path::new(path);
        self.sftp
            .unlink(file)
            .map_err(|e| TerminalError::SshError(format!("unlink failed: {}", e)))
    }

    /// Remove an empty directory on the remote host.
    pub fn remove_dir(&self, path: &str) -> Result<(), TerminalError> {
        let dir = std::path::Path::new(path);
        self.sftp
            .rmdir(dir)
            .map_err(|e| TerminalError::SshError(format!("rmdir failed: {}", e)))
    }

    /// Rename a file or directory on the remote host.
    pub fn rename(&self, old_path: &str, new_path: &str) -> Result<(), TerminalError> {
        let old = std::path::Path::new(old_path);
        let new = std::path::Path::new(new_path);
        self.sftp
            .rename(old, new, None)
            .map_err(|e| TerminalError::SshError(format!("rename failed: {}", e)))
    }
}

/// Manages multiple SFTP sessions keyed by UUID.
pub struct SftpManager {
    sessions: Mutex<HashMap<String, Arc<Mutex<SftpSession>>>>,
}

impl SftpManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Open a new SFTP session. Returns the session UUID.
    pub fn open_session(&self, config: &SshConfig) -> Result<String, TerminalError> {
        let session = SftpSession::new(config)?;
        let id = uuid::Uuid::new_v4().to_string();
        let mut sessions = self.sessions.lock().unwrap();
        sessions.insert(id.clone(), Arc::new(Mutex::new(session)));
        Ok(id)
    }

    /// Close and drop an SFTP session.
    pub fn close_session(&self, id: &str) {
        let mut sessions = self.sessions.lock().unwrap();
        sessions.remove(id);
    }

    /// Get a session Arc for use outside the manager lock.
    pub fn get_session(
        &self,
        id: &str,
    ) -> Result<Arc<Mutex<SftpSession>>, TerminalError> {
        let sessions = self.sessions.lock().unwrap();
        sessions
            .get(id)
            .cloned()
            .ok_or_else(|| TerminalError::SftpSessionNotFound(id.to_string()))
    }
}
