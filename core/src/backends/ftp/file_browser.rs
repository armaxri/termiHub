//! FTP-backed file browser implementing [`FileBrowser`].
//!
//! Opens a dedicated FTP control connection for file operations (mirroring the
//! SFTP browser, which likewise runs on its own connection independent of the
//! terminal session). The connection is established lazily on first use behind
//! an async [`Mutex`] and reused for subsequent operations.
//!
//! Directory listings prefer the machine-readable `MLSD` command and fall back
//! to `LIST` (parsed by [`listing_parser`](super::listing_parser)) when the
//! server does not support it.

use std::sync::Arc;

use futures_util::io::{AsyncReadExt, Cursor};
use suppaftp::{AsyncRustlsFtpStream, FtpError};
use tokio::sync::Mutex;

use crate::config::FtpConfig;
use crate::errors::FileError;
use crate::files::{FileBrowser, FileEntry};

use super::listing_parser::{parse_list, parse_mlsd, parse_mlsd_line};

/// FTP-backed file browser for a single FTP/FTPS connection.
///
/// The underlying control connection is opened on first use and reused; it is
/// dropped (closing the socket) when the browser is dropped on disconnect.
pub(crate) struct FtpFileBrowser {
    config: FtpConfig,
    client: Arc<Mutex<Option<AsyncRustlsFtpStream>>>,
}

/// Map a [`suppaftp`] error to a [`FileError`], tagging it with the operation.
fn map_err(op: &str, err: FtpError) -> FileError {
    FileError::OperationFailed(format!("FTP {op} failed: {err}"))
}

impl FtpFileBrowser {
    /// Create a browser for `config`; no connection is opened until first use.
    pub(crate) fn new(config: FtpConfig) -> Self {
        Self {
            config,
            client: Arc::new(Mutex::new(None)),
        }
    }

    /// Ensure the browsing control connection is established.
    async fn ensure_connected(&self) -> Result<(), FileError> {
        let mut guard = self.client.lock().await;
        if guard.is_some() {
            return Ok(());
        }
        let stream = super::establish(&self.config)
            .await
            .map_err(|e| FileError::OperationFailed(format!("FTP connection failed: {e}")))?;
        *guard = Some(stream);
        Ok(())
    }
}

/// Split a path into its parent directory and base name.
///
/// The parent defaults to `"."` when the path has no separator, mirroring how
/// FTP servers interpret a bare name in the working directory.
fn split_parent(path: &str) -> (String, String) {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rsplit_once('/') {
        Some(("", base)) => ("/".to_string(), base.to_string()),
        Some((parent, base)) => (parent.to_string(), base.to_string()),
        None => (".".to_string(), trimmed.to_string()),
    }
}

#[async_trait::async_trait]
impl FileBrowser for FtpFileBrowser {
    async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, FileError> {
        self.ensure_connected().await?;
        let mut guard = self.client.lock().await;
        let stream = guard
            .as_mut()
            .ok_or_else(|| FileError::OperationFailed("FTP not connected".to_string()))?;

        // Prefer MLSD (machine-readable); fall back to LIST when unsupported.
        match stream.mlsd(Some(path)).await {
            Ok(lines) => Ok(parse_mlsd(&lines, path)),
            Err(_) => {
                let lines = stream
                    .list(Some(path))
                    .await
                    .map_err(|e| map_err("LIST", e))?;
                Ok(parse_list(&lines, path))
            }
        }
    }

    async fn read_file(&self, path: &str) -> Result<Vec<u8>, FileError> {
        self.ensure_connected().await?;
        let mut guard = self.client.lock().await;
        let stream = guard
            .as_mut()
            .ok_or_else(|| FileError::OperationFailed("FTP not connected".to_string()))?;

        let mut data_stream = stream
            .retr_as_stream(path)
            .await
            .map_err(|e| map_err("RETR", e))?;
        let mut buf = Vec::new();
        data_stream
            .read_to_end(&mut buf)
            .await
            .map_err(|e| FileError::OperationFailed(format!("FTP read failed: {e}")))?;
        stream
            .finalize_retr_stream(data_stream)
            .await
            .map_err(|e| map_err("RETR", e))?;
        Ok(buf)
    }

    async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), FileError> {
        self.ensure_connected().await?;
        let mut guard = self.client.lock().await;
        let stream = guard
            .as_mut()
            .ok_or_else(|| FileError::OperationFailed("FTP not connected".to_string()))?;

        let mut cursor = Cursor::new(data);
        stream
            .put_file(path, &mut cursor)
            .await
            .map_err(|e| map_err("STOR", e))?;
        Ok(())
    }

    async fn delete(&self, path: &str) -> Result<(), FileError> {
        self.ensure_connected().await?;
        let mut guard = self.client.lock().await;
        let stream = guard
            .as_mut()
            .ok_or_else(|| FileError::OperationFailed("FTP not connected".to_string()))?;

        // FTP deletes files with DELE and directories with RMD, and the trait
        // does not tell us which. Try DELE first; on failure, treat it as a
        // directory and try RMD.
        match stream.rm(path).await {
            Ok(()) => Ok(()),
            Err(file_err) => stream.rmdir(path).await.map_err(|dir_err| {
                FileError::OperationFailed(format!(
                    "FTP delete failed (DELE: {file_err}; RMD: {dir_err})"
                ))
            }),
        }
    }

    async fn rename(&self, from: &str, to: &str) -> Result<(), FileError> {
        self.ensure_connected().await?;
        let mut guard = self.client.lock().await;
        let stream = guard
            .as_mut()
            .ok_or_else(|| FileError::OperationFailed("FTP not connected".to_string()))?;

        stream
            .rename(from, to)
            .await
            .map_err(|e| map_err("RNFR/RNTO", e))
    }

    async fn stat(&self, path: &str) -> Result<FileEntry, FileError> {
        // The filesystem root has no parent to list; synthesize it.
        if path == "/" || path.is_empty() {
            return Ok(FileEntry {
                name: "/".to_string(),
                path: "/".to_string(),
                is_directory: true,
                size: 0,
                modified: String::new(),
                permissions: None,
                writable: None,
            });
        }

        self.ensure_connected().await?;
        let (parent, base) = split_parent(path);

        let mut guard = self.client.lock().await;
        let stream = guard
            .as_mut()
            .ok_or_else(|| FileError::OperationFailed("FTP not connected".to_string()))?;

        // Prefer MLST (single-entry machine listing).
        if let Ok(line) = stream.mlst(Some(path)).await {
            if let Some(entry) = parse_mlsd_line(line.as_bytes(), &parent) {
                return Ok(entry);
            }
        }

        // Fall back to listing the parent and matching by name.
        let entries = match stream.mlsd(Some(&parent)).await {
            Ok(lines) => parse_mlsd(&lines, &parent),
            Err(_) => {
                let lines = stream
                    .list(Some(&parent))
                    .await
                    .map_err(|e| map_err("LIST", e))?;
                parse_list(&lines, &parent)
            }
        };

        entries
            .into_iter()
            .find(|e| e.name == base)
            .ok_or_else(|| FileError::NotFound(path.to_string()))
    }

    async fn mkdir(&self, path: &str) -> Result<(), FileError> {
        self.ensure_connected().await?;
        let mut guard = self.client.lock().await;
        let stream = guard
            .as_mut()
            .ok_or_else(|| FileError::OperationFailed("FTP not connected".to_string()))?;

        stream.mkdir(path).await.map_err(|e| map_err("MKD", e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_parent_handles_common_shapes() {
        assert_eq!(
            split_parent("/pub/docs/file.txt"),
            ("/pub/docs".to_string(), "file.txt".to_string())
        );
        assert_eq!(split_parent("/top"), ("/".to_string(), "top".to_string()));
        assert_eq!(split_parent("bare"), (".".to_string(), "bare".to_string()));
        // Trailing slash is ignored.
        assert_eq!(
            split_parent("/pub/docs/"),
            ("/pub".to_string(), "docs".to_string())
        );
    }

    #[test]
    fn browser_is_send() {
        fn assert_send<T: Send>() {}
        assert_send::<FtpFileBrowser>();
        assert_send::<Box<dyn FileBrowser>>();
    }
}
