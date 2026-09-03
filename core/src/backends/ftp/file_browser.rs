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
//!
//! ## Robustness (issue #1339)
//!
//! Every operation runs through [`reconnect::run_with_reconnect`]: a transport
//! failure (a dropped idle control connection, a transient network fault)
//! transparently re-establishes the connection and retries, up to
//! [`reconnect::MAX_RECONNECT_RETRIES`] times. Each reconnect also advances the
//! data-channel fallback one step (extended passive → passive), so a server that
//! rejects `EPSV` degrades gracefully to classic `PASV`.

use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use std::io::Cursor;

use suppaftp::tokio::AsyncRustlsFtpStream;
use suppaftp::{FtpError, Mode};
use tokio::io::AsyncReadExt;
use tokio::sync::Mutex;

use crate::config::FtpConfig;
use crate::errors::FileError;
use crate::files::{FileBrowser, FileEntry};

use super::listing_parser::{parse_list, parse_mlsd, parse_mlsd_line};
use super::reconnect;

/// FTP-backed file browser for a single FTP/FTPS connection.
///
/// The underlying control connection is opened on first use and reused; it is
/// dropped (closing the socket) when the browser is dropped on disconnect.
pub(crate) struct FtpFileBrowser {
    config: FtpConfig,
    client: Arc<Mutex<Option<AsyncRustlsFtpStream>>>,
    /// Ordered data-channel modes to try (`EPSV`→`PASV` for passive). The index
    /// advances on each reconnect, so a passive-mode data failure degrades to
    /// the more widely supported classic `PASV`.
    data_modes: Vec<Mode>,
    /// Current index into [`data_modes`](Self::data_modes).
    mode_index: AtomicUsize,
}

/// Map a [`suppaftp`] error to a [`FileError`], tagging it with the operation.
fn map_err(op: &str, err: FtpError) -> FileError {
    FileError::OperationFailed(format!("FTP {op} failed: {err}"))
}

impl FtpFileBrowser {
    /// Create a browser for `config`; no connection is opened until first use.
    pub(crate) fn new(config: FtpConfig) -> Self {
        let data_modes = super::data_mode_chain(config.mode);
        Self {
            config,
            client: Arc::new(Mutex::new(None)),
            data_modes,
            mode_index: AtomicUsize::new(0),
        }
    }

    /// A clone of the shared control-connection handle, for the keep-alive task.
    pub(crate) fn shared_client(&self) -> Arc<Mutex<Option<AsyncRustlsFtpStream>>> {
        self.client.clone()
    }

    /// Test-only: forcibly tear the live control connection down to simulate a
    /// mid-session control-connection drop. Dropping the stream closes its
    /// underlying socket, so the next operation re-establishes it via the
    /// reconnect path. Returns `true` if a connection was open and closed.
    #[doc(hidden)]
    pub(crate) async fn debug_drop_connection(&self) -> bool {
        let mut guard = self.client.lock().await;
        // Dropping the `AsyncRustlsFtpStream` closes the OS socket (its `Drop`
        // shuts the fd down); the next file op then sees an absent stream and
        // reconnects, exactly as it would after a real idle-timeout / fault.
        guard.take().is_some()
    }

    /// The data-channel mode currently in effect (the reconnect fallback point).
    fn current_mode(&self) -> Mode {
        let last = self.data_modes.len().saturating_sub(1);
        let idx = self.mode_index.load(Ordering::Relaxed).min(last);
        self.data_modes.get(idx).copied().unwrap_or(Mode::Passive)
    }

    /// Ensure the browsing control connection is established (using the current
    /// data-channel mode).
    async fn ensure_connected(&self) -> Result<(), FileError> {
        let mut guard = self.client.lock().await;
        if guard.is_some() {
            return Ok(());
        }
        let stream = super::establish_with_mode(&self.config, self.current_mode())
            .await
            .map_err(|e| FileError::OperationFailed(format!("FTP connection failed: {e}")))?;
        *guard = Some(stream);
        Ok(())
    }

    /// Re-establish the control connection after a drop, advancing the
    /// data-channel fallback one step (`EPSV`→`PASV`) so a passive failure
    /// degrades gracefully.
    async fn reconnect(&self) -> Result<(), FtpError> {
        let last = self.data_modes.len().saturating_sub(1);
        let prev = self.mode_index.load(Ordering::Relaxed);
        if prev < last {
            self.mode_index.store(prev + 1, Ordering::Relaxed);
        }
        let mut guard = self.client.lock().await;
        *guard = None;
        let stream = super::establish_with_mode(&self.config, self.current_mode())
            .await
            .map_err(|e| {
                FtpError::ConnectionError(std::io::Error::other(format!(
                    "FTP reconnect failed: {e}"
                )))
            })?;
        *guard = Some(stream);
        Ok(())
    }

    /// Run `op` with the auto-reconnect retry policy, mapping the final error to
    /// a [`FileError`] tagged with `op_name`.
    async fn with_reconnect<T, Op, OpFut>(&self, op_name: &str, op: Op) -> Result<T, FileError>
    where
        Op: FnMut() -> OpFut,
        OpFut: Future<Output = Result<T, FtpError>>,
    {
        self.ensure_connected().await?;
        reconnect::run_with_reconnect(
            reconnect::MAX_RECONNECT_RETRIES,
            reconnect::is_connection_error,
            reconnect::reconnect_backoff,
            op,
            || self.reconnect(),
        )
        .await
        .map_err(|e| map_err(op_name, e))
    }

    /// Lock the shared stream, returning a retryable "not connected" error when
    /// the slot is empty (so the retry driver reconnects).
    async fn locked_stream(&self) -> tokio::sync::MutexGuard<'_, Option<AsyncRustlsFtpStream>> {
        self.client.lock().await
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
        self.with_reconnect("LIST", || async {
            let mut guard = self.locked_stream().await;
            let stream = guard.as_mut().ok_or_else(reconnect::not_connected_err)?;
            // Prefer MLSD (machine-readable). A connection error propagates so the
            // driver reconnects; a protocol error means MLSD is unsupported, so we
            // fall back to LIST on the (still-live) connection.
            match stream.mlsd(Some(path)).await {
                Ok(lines) => Ok(parse_mlsd(&lines, path)),
                Err(FtpError::ConnectionError(e)) => Err(FtpError::ConnectionError(e)),
                Err(_) => {
                    let lines = stream.list(Some(path)).await?;
                    Ok(parse_list(&lines, path))
                }
            }
        })
        .await
    }

    async fn read_file(&self, path: &str) -> Result<Vec<u8>, FileError> {
        self.with_reconnect("RETR", || async {
            let mut guard = self.locked_stream().await;
            let stream = guard.as_mut().ok_or_else(reconnect::not_connected_err)?;
            let mut data_stream = stream.retr_as_stream(path).await?;
            let mut buf = Vec::new();
            data_stream
                .read_to_end(&mut buf)
                .await
                .map_err(FtpError::ConnectionError)?;
            stream.finalize_retr_stream(data_stream).await?;
            Ok(buf)
        })
        .await
    }

    async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), FileError> {
        self.with_reconnect("STOR", || async {
            let mut guard = self.locked_stream().await;
            let stream = guard.as_mut().ok_or_else(reconnect::not_connected_err)?;
            let mut cursor = Cursor::new(data);
            stream.put_file(path, &mut cursor).await?;
            Ok(())
        })
        .await
    }

    async fn delete(&self, path: &str) -> Result<(), FileError> {
        // FTP deletes files with DELE and directories with RMD, and the trait
        // does not tell us which. Try DELE first; on a *protocol* failure, treat
        // it as a directory and try RMD. A connection error propagates so the
        // retry driver reconnects rather than misfiring RMD on a dead stream.
        self.with_reconnect("delete", || async {
            let mut guard = self.locked_stream().await;
            let stream = guard.as_mut().ok_or_else(reconnect::not_connected_err)?;
            match stream.rm(path).await {
                Ok(()) => Ok(()),
                Err(FtpError::ConnectionError(e)) => Err(FtpError::ConnectionError(e)),
                Err(_) => stream.rmdir(path).await,
            }
        })
        .await
    }

    async fn rename(&self, from: &str, to: &str) -> Result<(), FileError> {
        self.with_reconnect("RNFR/RNTO", || async {
            let mut guard = self.locked_stream().await;
            let stream = guard.as_mut().ok_or_else(reconnect::not_connected_err)?;
            stream.rename(from, to).await
        })
        .await
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
                is_symlink: false,
                symlink_target: None,
            });
        }

        let (parent, base) = split_parent(path);

        let found = self
            .with_reconnect("stat", || async {
                let mut guard = self.locked_stream().await;
                let stream = guard.as_mut().ok_or_else(reconnect::not_connected_err)?;

                // Prefer MLST (single-entry machine listing).
                if let Ok(line) = stream.mlst(Some(path)).await {
                    if let Some(entry) = parse_mlsd_line(line.as_bytes(), &parent) {
                        return Ok(Some(entry));
                    }
                }

                // Fall back to listing the parent and matching by name.
                let entries = match stream.mlsd(Some(&parent)).await {
                    Ok(lines) => parse_mlsd(&lines, &parent),
                    Err(FtpError::ConnectionError(e)) => return Err(FtpError::ConnectionError(e)),
                    Err(_) => {
                        let lines = stream.list(Some(&parent)).await?;
                        parse_list(&lines, &parent)
                    }
                };
                Ok(entries.into_iter().find(|e| e.name == base))
            })
            .await?;

        found.ok_or_else(|| FileError::NotFound(path.to_string()))
    }

    async fn mkdir(&self, path: &str) -> Result<(), FileError> {
        self.with_reconnect("MKD", || async {
            let mut guard = self.locked_stream().await;
            let stream = guard.as_mut().ok_or_else(reconnect::not_connected_err)?;
            stream.mkdir(path).await
        })
        .await
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

    #[test]
    fn passive_browser_starts_on_extended_passive_then_falls_back() {
        // A passive-mode browser begins on EPSV; after a reconnect the fallback
        // advances one step to classic PASV, and stays there.
        let browser = FtpFileBrowser::new(FtpConfig::default());
        assert_eq!(browser.current_mode(), Mode::ExtendedPassive);

        // Simulate the reconnect fallback advance (without a live server).
        browser.mode_index.store(1, Ordering::Relaxed);
        assert_eq!(browser.current_mode(), Mode::Passive);

        // Never advances past the last entry.
        browser.mode_index.store(99, Ordering::Relaxed);
        assert_eq!(browser.current_mode(), Mode::Passive);
    }

    #[test]
    fn active_browser_has_single_mode() {
        let cfg = FtpConfig {
            mode: crate::config::FtpDataMode::Active,
            ..FtpConfig::default()
        };
        let browser = FtpFileBrowser::new(cfg);
        assert_eq!(browser.current_mode(), Mode::Active);
        // No fallback exists; the mode is stable even if the index is bumped.
        browser.mode_index.store(5, Ordering::Relaxed);
        assert_eq!(browser.current_mode(), Mode::Active);
    }
}
