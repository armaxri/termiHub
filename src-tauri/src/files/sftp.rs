use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use ssh2::{Session, Sftp};
use tracing::{debug, info};

use crate::terminal::backend::SshConfig;
use crate::utils::errors::TerminalError;
use crate::utils::ssh_auth::connect_and_authenticate;
use termihub_core::errors::FileError;
use termihub_core::files::utils::{chrono_from_epoch, format_permissions};
use termihub_core::files::{FileBackend, FileEntry};

/// Legacy SFTP session wrapping a dedicated SSH connection.
///
/// Uses blocking mode — each SFTP session opens its own SSH connection
/// to avoid conflicts with the terminal session's non-blocking mode.
///
/// The canonical implementation is now
/// [`termihub_core::backends::ssh::SftpFileBrowser`](termihub_core::backends::ssh)
/// which implements the unified `FileBrowser` trait. This struct will be
/// removed once file browsing is migrated to use `ConnectionType`.
pub struct SftpSession {
    _session: Session,
    sftp: Sftp,
}

impl SftpSession {
    /// Open a new SFTP session to the given SSH host.
    pub fn new(config: &SshConfig) -> Result<Self, TerminalError> {
        info!(host = %config.host, port = config.port, "Opening SFTP connection");
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
        debug!(path, "SFTP listing directory");
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
            let modified = stat.mtime.map(chrono_from_epoch).unwrap_or_default();
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
    pub fn read_file(&self, remote_path: &str, local_path: &str) -> Result<u64, TerminalError> {
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
    pub fn write_file(&self, local_path: &str, remote_path: &str) -> Result<u64, TerminalError> {
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

    /// Read a remote file's contents as a UTF-8 string.
    pub fn read_file_content(&self, remote_path: &str) -> Result<String, TerminalError> {
        let remote = std::path::Path::new(remote_path);
        let mut remote_file = self
            .sftp
            .open(remote)
            .map_err(|e| TerminalError::SshError(format!("open remote file failed: {}", e)))?;

        let mut content = String::new();
        remote_file
            .read_to_string(&mut content)
            .map_err(|e| TerminalError::SshError(format!("read failed: {}", e)))?;

        Ok(content)
    }

    /// Write a string to a remote file, creating or overwriting it.
    pub fn write_file_content(
        &self,
        remote_path: &str,
        content: &str,
    ) -> Result<(), TerminalError> {
        let remote = std::path::Path::new(remote_path);
        let mut remote_file = self
            .sftp
            .create(remote)
            .map_err(|e| TerminalError::SshError(format!("create remote file failed: {}", e)))?;

        remote_file
            .write_all(content.as_bytes())
            .map_err(|e| TerminalError::SshError(format!("write failed: {}", e)))?;

        Ok(())
    }

    /// Rename a file or directory on the remote host.
    pub fn rename(&self, old_path: &str, new_path: &str) -> Result<(), TerminalError> {
        let old = std::path::Path::new(old_path);
        let new = std::path::Path::new(new_path);
        self.sftp
            .rename(old, new, None)
            .map_err(|e| TerminalError::SshError(format!("rename failed: {}", e)))
    }

    /// Get metadata for a single file or directory.
    #[allow(dead_code)]
    pub fn stat(&self, path: &str) -> Result<FileEntry, TerminalError> {
        let p = std::path::Path::new(path);
        let file_stat = self
            .sftp
            .stat(p)
            .map_err(|e| TerminalError::SshError(format!("stat failed: {}", e)))?;

        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let is_directory = file_stat.is_dir();
        let size = file_stat.size.unwrap_or(0);
        let modified = file_stat.mtime.map(chrono_from_epoch).unwrap_or_default();
        let permissions = file_stat.perm.map(format_permissions);

        Ok(FileEntry {
            name,
            path: path.to_string(),
            is_directory,
            size,
            modified,
            permissions,
        })
    }

    /// Read a remote file's contents as raw bytes.
    #[allow(dead_code)]
    pub fn read_bytes(&self, remote_path: &str) -> Result<Vec<u8>, TerminalError> {
        let remote = std::path::Path::new(remote_path);
        let mut remote_file = self
            .sftp
            .open(remote)
            .map_err(|e| TerminalError::SshError(format!("open remote file failed: {}", e)))?;

        let mut data = Vec::new();
        remote_file
            .read_to_end(&mut data)
            .map_err(|e| TerminalError::SshError(format!("read failed: {}", e)))?;

        Ok(data)
    }

    /// Write raw bytes to a remote file, creating or overwriting it.
    #[allow(dead_code)]
    pub fn write_bytes(&self, remote_path: &str, data: &[u8]) -> Result<(), TerminalError> {
        let remote = std::path::Path::new(remote_path);
        let mut remote_file = self
            .sftp
            .create(remote)
            .map_err(|e| TerminalError::SshError(format!("create remote file failed: {}", e)))?;

        remote_file
            .write_all(data)
            .map_err(|e| TerminalError::SshError(format!("write failed: {}", e)))?;

        Ok(())
    }
}

/// Map a `TerminalError` to a `FileError::OperationFailed`.
#[allow(dead_code)]
fn terminal_error_to_file_error(e: TerminalError) -> FileError {
    FileError::OperationFailed(e.to_string())
}

/// Async file backend implementation backed by an SFTP session.
///
/// Wraps an `Arc<Mutex<SftpSession>>` and implements the core [`FileBackend`]
/// trait. Each async method offloads the blocking SFTP call to
/// `tauri::async_runtime::spawn_blocking` to avoid blocking the async
/// executor.
#[allow(dead_code)]
pub struct SftpFileBackend {
    session: Arc<Mutex<SftpSession>>,
}

#[allow(dead_code)]
impl SftpFileBackend {
    /// Create a new file backend from an existing SFTP session.
    pub fn new(session: Arc<Mutex<SftpSession>>) -> Self {
        Self { session }
    }
}

#[async_trait::async_trait]
impl FileBackend for SftpFileBackend {
    async fn list(&self, path: &str) -> Result<Vec<FileEntry>, FileError> {
        let session = self.session.clone();
        let path = path.to_string();
        tauri::async_runtime::spawn_blocking(move || {
            let sftp = session.lock().map_err(|e| {
                FileError::OperationFailed(format!("Failed to lock SFTP session: {e}"))
            })?;
            sftp.list_dir(&path).map_err(terminal_error_to_file_error)
        })
        .await
        .map_err(|e| FileError::OperationFailed(format!("Task join failed: {e}")))?
    }

    async fn read(&self, path: &str) -> Result<Vec<u8>, FileError> {
        let session = self.session.clone();
        let path = path.to_string();
        tauri::async_runtime::spawn_blocking(move || {
            let sftp = session.lock().map_err(|e| {
                FileError::OperationFailed(format!("Failed to lock SFTP session: {e}"))
            })?;
            sftp.read_bytes(&path).map_err(terminal_error_to_file_error)
        })
        .await
        .map_err(|e| FileError::OperationFailed(format!("Task join failed: {e}")))?
    }

    async fn write(&self, path: &str, data: &[u8]) -> Result<(), FileError> {
        let session = self.session.clone();
        let path = path.to_string();
        let data = data.to_vec();
        tauri::async_runtime::spawn_blocking(move || {
            let sftp = session.lock().map_err(|e| {
                FileError::OperationFailed(format!("Failed to lock SFTP session: {e}"))
            })?;
            sftp.write_bytes(&path, &data)
                .map_err(terminal_error_to_file_error)
        })
        .await
        .map_err(|e| FileError::OperationFailed(format!("Task join failed: {e}")))?
    }

    async fn delete(&self, path: &str, is_directory: bool) -> Result<(), FileError> {
        let session = self.session.clone();
        let path = path.to_string();
        tauri::async_runtime::spawn_blocking(move || {
            let sftp = session.lock().map_err(|e| {
                FileError::OperationFailed(format!("Failed to lock SFTP session: {e}"))
            })?;
            if is_directory {
                sftp.remove_dir(&path)
            } else {
                sftp.remove_file(&path)
            }
            .map_err(terminal_error_to_file_error)
        })
        .await
        .map_err(|e| FileError::OperationFailed(format!("Task join failed: {e}")))?
    }

    async fn rename(&self, old_path: &str, new_path: &str) -> Result<(), FileError> {
        let session = self.session.clone();
        let old_path = old_path.to_string();
        let new_path = new_path.to_string();
        tauri::async_runtime::spawn_blocking(move || {
            let sftp = session.lock().map_err(|e| {
                FileError::OperationFailed(format!("Failed to lock SFTP session: {e}"))
            })?;
            sftp.rename(&old_path, &new_path)
                .map_err(terminal_error_to_file_error)
        })
        .await
        .map_err(|e| FileError::OperationFailed(format!("Task join failed: {e}")))?
    }

    async fn stat(&self, path: &str) -> Result<FileEntry, FileError> {
        let session = self.session.clone();
        let path = path.to_string();
        tauri::async_runtime::spawn_blocking(move || {
            let sftp = session.lock().map_err(|e| {
                FileError::OperationFailed(format!("Failed to lock SFTP session: {e}"))
            })?;
            sftp.stat(&path).map_err(terminal_error_to_file_error)
        })
        .await
        .map_err(|e| FileError::OperationFailed(format!("Task join failed: {e}")))?
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
        info!(session_id = id, "Closing SFTP session");
        let mut sessions = self.sessions.lock().unwrap();
        sessions.remove(id);
    }

    /// Get a session Arc for use outside the manager lock.
    pub fn get_session(&self, id: &str) -> Result<Arc<Mutex<SftpSession>>, TerminalError> {
        let sessions = self.sessions.lock().unwrap();
        sessions
            .get(id)
            .cloned()
            .ok_or_else(|| TerminalError::SftpSessionNotFound(id.to_string()))
    }
}
