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

use std::any::Any;
use std::future::Future;
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::Arc;

use std::io::Cursor;

use suppaftp::tokio::AsyncRustlsFtpStream;
use suppaftp::{FtpError, Mode};
use tokio::io::AsyncReadExt;
use tokio::sync::Mutex;

use crate::config::{FtpConfig, FtpTransferType};
use crate::errors::FileError;
use crate::files::{FileBrowser, FileEntry, RangedFileAccess};

use super::listing_parser::{parse_list, parse_mlsd, parse_mlsd_line};
use super::reconnect;
use super::transfer::FtpServerCaps;

/// [`FtpFileBrowser::rest_stream`]: no connection has answered `FEAT` yet.
const REST_UNKNOWN: u8 = 0;
/// [`FtpFileBrowser::rest_stream`]: the server advertised `REST STREAM`.
const REST_SUPPORTED: u8 = 1;
/// [`FtpFileBrowser::rest_stream`]: the server did not advertise `REST STREAM`
/// (or did not answer `FEAT` at all).
const REST_UNSUPPORTED: u8 = 2;

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
    /// Whether the server restarts transfers at an offset (`REST STREAM` in its
    /// `FEAT` reply), learned on every (re)connect: one of [`REST_UNKNOWN`],
    /// [`REST_SUPPORTED`], [`REST_UNSUPPORTED`]. Gates ranged access (#4113).
    rest_stream: AtomicU8,
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
            rest_stream: AtomicU8::new(REST_UNKNOWN),
        }
    }

    /// A clone of the shared control-connection handle, for the keep-alive task.
    pub(crate) fn shared_client(&self) -> Arc<Mutex<Option<AsyncRustlsFtpStream>>> {
        self.client.clone()
    }

    /// The connection settings backing this browser, cloned.
    ///
    /// Lets a session-scoped caller (holding only a `&dyn FileBrowser`, via
    /// [`ftp_config_of`](super::ftp_config_of)) recover the settings needed to
    /// launch a queued FTP transfer on its own connection — mirroring how the
    /// SFTP path clones its browser to run a transfer without holding the session
    /// lock. The settings never leave the backend: they are resolved server-side
    /// so credentials are never round-tripped through the frontend (PROD-010).
    pub(crate) fn config(&self) -> FtpConfig {
        self.config.clone()
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
        *guard = Some(self.learn_caps(stream).await);
        Ok(())
    }

    /// Record whether the freshly established `stream`'s server advertises
    /// `REST STREAM` (#4113), then hand the stream back. A server that does not
    /// answer `FEAT` counts as not supporting it: ranged access is refused
    /// rather than guessed.
    async fn learn_caps(&self, mut stream: AsyncRustlsFtpStream) -> AsyncRustlsFtpStream {
        let rest = match stream.feat().await {
            Ok(features) if FtpServerCaps::from_features(&features).rest_stream => REST_SUPPORTED,
            _ => REST_UNSUPPORTED,
        };
        self.rest_stream.store(rest, Ordering::Relaxed);
        stream
    }

    /// Whether ranged access is possible on this connection: binary transfers
    /// (an ASCII transfer rewrites line endings, so byte offsets would not
    /// match the file), and a server not known to lack `REST STREAM`. Before
    /// the first connection the server is unknown and ranged access is offered;
    /// each ranged call connects first and refuses if the server lacks it.
    fn ranged_possible(&self) -> bool {
        self.config.transfer_type == FtpTransferType::Binary
            && self.rest_stream.load(Ordering::Relaxed) != REST_UNSUPPORTED
    }

    /// Connect if needed, then refuse with [`FileError::NotSupported`] unless
    /// ranged access is possible on the live connection.
    async fn ensure_ranged(&self) -> Result<(), FileError> {
        self.ensure_connected().await?;
        if self.ranged_possible() {
            Ok(())
        } else {
            Err(FileError::NotSupported)
        }
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
        *guard = Some(self.learn_caps(stream).await);
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

    /// FTP has no portable chmod (`SITE CHMOD` is optional and non-standard), so
    /// changing permissions is unsupported.
    async fn set_permissions(&self, _path: &str, _mode: u32) -> Result<(), FileError> {
        Err(FileError::NotSupported)
    }

    /// FTP has no portable owner-change command, so chown is unsupported.
    async fn set_owner(
        &self,
        _path: &str,
        _uid: Option<u32>,
        _gid: Option<u32>,
    ) -> Result<(), FileError> {
        Err(FileError::NotSupported)
    }

    /// FTP has no symlink-create command, so it is unsupported.
    async fn create_symlink(&self, _target: &str, _link_path: &str) -> Result<(), FileError> {
        Err(FileError::NotSupported)
    }

    /// FTP has no server-side copy command, so same-backend copy is unsupported.
    async fn copy(&self, _src: &str, _dest: &str) -> Result<(), FileError> {
        Err(FileError::NotSupported)
    }

    /// Expose the concrete browser so a session-scoped caller holding only a
    /// `&dyn FileBrowser` can recover the [`FtpConfig`] (via
    /// [`ftp_config_of`](super::ftp_config_of)) needed to launch a queued FTP
    /// transfer, mirroring the SFTP browser's downcast hook (PROD-010).
    fn as_any(&self) -> Option<&dyn Any> {
        Some(self)
    }

    /// Offset-addressed slices (#4113) — what an agent-hosted FTP session's
    /// queued transfer moves through. Withheld for ASCII transfers and for a
    /// server known not to restart at an offset (no `REST STREAM`).
    fn ranged(&self) -> Option<&dyn RangedFileAccess> {
        self.ranged_possible()
            .then_some(self as &dyn RangedFileAccess)
    }
}

/// `REST <offset>` takes a `usize` in `suppaftp`; an offset beyond this
/// platform's range is a hard error rather than a silently truncated position.
fn rest_offset(path: &str, offset: u64) -> Result<usize, FileError> {
    usize::try_from(offset).map_err(|_| {
        FileError::OperationFailed(format!(
            "{path}: offset {offset} exceeds this platform's addressable range"
        ))
    })
}

/// Map a refused `SIZE` to a typed error: a `550` reply means the file is not
/// there (the trait's "an offset write needs an existing file").
fn size_error(path: &str, err: FtpError) -> FileError {
    match &err {
        FtpError::UnexpectedResponse(r) if r.status == suppaftp::Status::FileUnavailable => {
            FileError::NotFound(path.to_string())
        }
        _ => map_err("SIZE", err),
    }
}

/// Offset-addressed FTP reads and writes (#4113).
///
/// - **Read**: `REST <offset>` + `RETR`, reading at most `len` bytes. A slice
///   that ends before the end of the file closes the data connection early and
///   consumes the server's one completion reply (`226`, or `426`/`451` for the
///   aborted transfer), so the control connection stays in step. `ABOR` is not
///   used: when the server has already finished sending, `ABOR` draws a second
///   reply whose count varies by server, which would desynchronise the control
///   connection.
/// - **Write**: `STOR` at offset 0 (create or truncate); for `offset > 0` a
///   `SIZE` that must equal `offset`, then `APPE`. The file can therefore never
///   be overwritten or left with a gap by a retried or resumed slice.
///
/// Each call holds the browsing connection only for its slice and runs under
/// the same auto-reconnect policy as every other operation. A retried write is
/// safe: the retry re-checks `SIZE` and refuses if the first attempt landed.
#[async_trait::async_trait]
impl RangedFileAccess for FtpFileBrowser {
    async fn read_range(&self, path: &str, offset: u64, len: u32) -> Result<Vec<u8>, FileError> {
        if len == 0 {
            return Ok(Vec::new());
        }
        self.ensure_ranged().await?;
        let rest = rest_offset(path, offset)?;
        let result = self
            .with_reconnect("ranged RETR", || async {
                let mut guard = self.locked_stream().await;
                let stream = guard.as_mut().ok_or_else(reconnect::not_connected_err)?;
                read_slice(stream, path, offset, rest, len).await
            })
            .await?;
        result
    }

    /// Connect if needed and learn whether the server restarts transfers at
    /// an offset (#4146): a persistent agent session's daemon forwards the
    /// desktop's zero-length probe here, so a server without `REST STREAM`
    /// is refused before the first slice rather than on it.
    async fn probe(&self) -> Result<(), FileError> {
        self.ensure_ranged().await
    }

    async fn write_range(&self, path: &str, offset: u64, data: &[u8]) -> Result<(), FileError> {
        self.ensure_ranged().await?;
        let result = self
            .with_reconnect("ranged STOR/APPE", || async {
                let mut guard = self.locked_stream().await;
                let stream = guard.as_mut().ok_or_else(reconnect::not_connected_err)?;
                if offset > 0 {
                    match stream.size(path).await {
                        Ok(present) if present as u64 == offset => {}
                        Ok(present) => {
                            return Ok(Err(crate::files::ranged::offset_mismatch(
                                path,
                                present as u64,
                                offset,
                            )));
                        }
                        Err(FtpError::ConnectionError(e)) => {
                            return Err(FtpError::ConnectionError(e))
                        }
                        Err(e) => return Ok(Err(size_error(path, e))),
                    }
                    let mut cursor = Cursor::new(data);
                    stream.append_file(path, &mut cursor).await?;
                } else {
                    let mut cursor = Cursor::new(data);
                    stream.put_file(path, &mut cursor).await?;
                }
                Ok(Ok(()))
            })
            .await?;
        result
    }
}

/// One ranged read on a live control connection (see [`RangedFileAccess`] for
/// [`FtpFileBrowser`]). The outer error is a transport failure the reconnect
/// driver retries (a re-read is harmless); the inner one is final.
async fn read_slice(
    stream: &mut AsyncRustlsFtpStream,
    path: &str,
    offset: u64,
    rest: usize,
    len: u32,
) -> Result<Result<Vec<u8>, FileError>, FtpError> {
    match read_slice_inner(stream, path, rest, len).await {
        Ok(data) => Ok(Ok(data)),
        Err(FtpError::ConnectionError(e)) => Err(FtpError::ConnectionError(e)),
        Err(e) => {
            if rest > 0 {
                // A refused transfer may leave the restart marker armed on some
                // servers; clear it so a later `STOR` cannot inherit it.
                let _ = stream.resume_transfer(0).await;
            }
            // `RETR` after `REST` past the end of the file is refused by some
            // servers instead of answered with no bytes. Past the end is an
            // empty read by the trait's contract, so check before failing.
            if offset > 0 && matches!(stream.size(path).await, Ok(size) if size as u64 <= offset) {
                return Ok(Ok(Vec::new()));
            }
            Ok(Err(match &e {
                FtpError::UnexpectedResponse(r)
                    if r.status == suppaftp::Status::FileUnavailable =>
                {
                    FileError::NotFound(path.to_string())
                }
                _ => map_err("ranged RETR", e),
            }))
        }
    }
}

/// `REST` + `RETR` + the bounded read; see [`read_slice`].
async fn read_slice_inner(
    stream: &mut AsyncRustlsFtpStream,
    path: &str,
    rest: usize,
    len: u32,
) -> Result<Vec<u8>, FtpError> {
    if rest > 0 {
        stream.resume_transfer(rest).await?;
    }
    let mut data_stream = stream.retr_as_stream(path).await?;
    let mut buf = Vec::with_capacity(len as usize);
    let read = (&mut data_stream)
        .take(u64::from(len))
        .read_to_end(&mut buf)
        .await;
    if let Err(e) = read {
        // Drop the data connection and consume whatever the server replies;
        // the transport error then makes the driver reconnect and retry.
        let _ = stream.close_data_connection(data_stream).await;
        return Err(FtpError::ConnectionError(e));
    }
    if buf.len() < len as usize {
        // The whole rest of the file arrived: a normal completion.
        stream.finalize_retr_stream(data_stream).await?;
    } else {
        // The slice ended (possibly before the end of the file): close the
        // data connection early. The server answers `226` when it had already
        // sent everything, or `426`/`451` for the transfer cut short; either
        // way exactly one reply is consumed and the control connection is in
        // step. Only a transport failure is an error.
        match stream.close_data_connection(data_stream).await {
            Ok(()) | Err(FtpError::UnexpectedResponse(_)) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(buf)
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

    #[tokio::test]
    async fn owner_symlink_copy_are_typed_not_supported() {
        // FTP is a byte-based backend: chown / symlink-create / same-backend copy
        // are unsupported and must return the typed `NotSupported` (not a stringy
        // error and not a silent success), matching how chmod degrades. This needs
        // no live server — the ops reject unconditionally.
        let browser = FtpFileBrowser::new(FtpConfig::default());
        assert!(matches!(
            browser.set_owner("/f", Some(0), Some(0)).await,
            Err(FileError::NotSupported)
        ));
        assert!(matches!(
            browser.create_symlink("/real", "/link").await,
            Err(FileError::NotSupported)
        ));
        assert!(matches!(
            browser.copy("/a", "/b").await,
            Err(FileError::NotSupported)
        ));
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

    // ── Ranged access (#4113) against the in-process mock server ───────────

    use super::super::mock_server::{MockFtpOptions, MockFtpServer, MockTransfer};

    /// Deterministic, non-repeating-ish content so a misplaced slice shows.
    fn pattern(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i * 7 % 251) as u8).collect()
    }

    async fn mock(options: MockFtpOptions) -> (MockFtpServer, FtpFileBrowser) {
        let server = MockFtpServer::start(options).await;
        let browser = FtpFileBrowser::new(server.config());
        (server, browser)
    }

    #[tokio::test]
    async fn ranged_reads_slices_mid_file_and_at_eof() {
        let (server, browser) = mock(MockFtpOptions::default()).await;
        let content = pattern(1000);
        server.put("/f.bin", &content, "20240101000000");
        let ranged = browser.ranged().expect("ranged before first connect");

        assert_eq!(
            ranged.read_range("/f.bin", 0, 10).await.unwrap(),
            &content[..10]
        );
        assert_eq!(
            ranged.read_range("/f.bin", 500, 100).await.unwrap(),
            &content[500..600]
        );
        // A short read at the end of the file.
        assert_eq!(
            ranged.read_range("/f.bin", 990, 100).await.unwrap(),
            &content[990..]
        );
        // Exactly at, and past, the end: no bytes.
        assert!(ranged
            .read_range("/f.bin", 1000, 10)
            .await
            .unwrap()
            .is_empty());
        assert!(ranged
            .read_range("/f.bin", 5000, 10)
            .await
            .unwrap()
            .is_empty());
        // A zero-length read does no I/O.
        let before = server.transfers().len();
        assert!(ranged.read_range("/f.bin", 3, 0).await.unwrap().is_empty());
        assert_eq!(server.transfers().len(), before);

        // Offsets travel as REST; offset 0 sends none.
        let offsets: Vec<u64> = server
            .transfers()
            .iter()
            .filter(|t| t.command == "RETR")
            .map(|t| t.offset)
            .collect();
        assert_eq!(offsets, vec![0, 500, 990, 1000, 5000]);
    }

    #[tokio::test]
    async fn ranged_read_cut_short_leaves_the_control_connection_usable() {
        let (server, browser) = mock(MockFtpOptions::default()).await;
        // Large enough that the server is still writing when the client closes
        // the data connection, so it answers `426` for the cut-short transfer.
        let content = pattern(8 * 1024 * 1024);
        server.put("/big.bin", &content, "20240101000000");
        let ranged = browser.ranged().unwrap();

        for offset in [0u64, 4096, 1_000_000] {
            let at = offset as usize;
            assert_eq!(
                ranged.read_range("/big.bin", offset, 16).await.unwrap(),
                &content[at..at + 16]
            );
        }
        // The same control connection still answers commands in step.
        let client = browser.shared_client();
        let mut guard = client.lock().await;
        let stream = guard.as_mut().expect("connection kept");
        stream.noop().await.expect("NOOP after the cut-short reads");
        assert_eq!(stream.size("/big.bin").await.unwrap(), content.len());
    }

    #[tokio::test]
    async fn ranged_read_of_a_missing_file_is_not_found() {
        let (_server, browser) = mock(MockFtpOptions::default()).await;
        let ranged = browser.ranged().unwrap();
        assert!(matches!(
            ranged.read_range("/missing", 0, 10).await,
            Err(FileError::NotFound(_))
        ));
        // A refused read at an offset clears the restart marker, so a later
        // `STOR` starts at zero.
        assert!(ranged.read_range("/missing", 7, 10).await.is_err());
        ranged.write_range("/new.bin", 0, b"abc").await.unwrap();
        assert_eq!(_server.get("/new.bin").unwrap(), b"abc");
        let stor = _server
            .transfers()
            .into_iter()
            .find(|t| t.command == "STOR");
        assert_eq!(
            stor,
            Some(MockTransfer {
                command: "STOR",
                path: "/new.bin".into(),
                offset: 0
            })
        );
    }

    #[tokio::test]
    async fn ranged_write_truncates_at_zero_then_appends_at_the_exact_size() {
        let (server, browser) = mock(MockFtpOptions::default()).await;
        server.put("/up.bin", b"old contents here", "20240101000000");
        let ranged = browser.ranged().unwrap();

        ranged.write_range("/up.bin", 0, b"abc").await.unwrap();
        assert_eq!(server.get("/up.bin").unwrap(), b"abc");
        ranged.write_range("/up.bin", 3, b"def").await.unwrap();
        ranged.write_range("/up.bin", 6, b"gh").await.unwrap();
        assert_eq!(server.get("/up.bin").unwrap(), b"abcdefgh");
        let commands: Vec<&str> = server.transfers().iter().map(|t| t.command).collect();
        assert_eq!(commands, vec!["STOR", "APPE", "APPE"]);

        // An empty first slice still creates (truncates) the file.
        ranged.write_range("/empty.bin", 0, b"").await.unwrap();
        assert_eq!(server.get("/empty.bin").unwrap(), b"");
    }

    #[tokio::test]
    async fn ranged_write_refuses_a_wrong_offset_without_writing() {
        let (server, browser) = mock(MockFtpOptions::default()).await;
        server.put("/up.bin", b"abcdef", "20240101000000");
        let ranged = browser.ranged().unwrap();

        // Behind the end: would overwrite bytes already there.
        let err = ranged.write_range("/up.bin", 4, b"X").await.unwrap_err();
        assert!(
            err.to_string().contains("holds 6 bytes, expected 4"),
            "{err}"
        );
        // Past the end: would leave a gap.
        assert!(ranged.write_range("/up.bin", 9, b"X").await.is_err());
        // At an offset the file must exist.
        assert!(matches!(
            ranged.write_range("/missing.bin", 3, b"X").await,
            Err(FileError::NotFound(_))
        ));
        assert_eq!(server.get("/up.bin").unwrap(), b"abcdef");
        assert!(server.transfers().is_empty(), "nothing was written");
    }

    #[tokio::test]
    async fn ranged_access_is_withheld_without_rest_stream() {
        for options in [
            MockFtpOptions {
                rest: false,
                ..MockFtpOptions::default()
            },
            // A legacy server that does not answer FEAT: refused, not guessed.
            MockFtpOptions {
                feat: false,
                ..MockFtpOptions::default()
            },
        ] {
            let (server, browser) = mock(options).await;
            server.put("/f.bin", b"0123456789", "20240101000000");
            // Unknown before the first connection, so offered...
            let ranged = browser.ranged().expect("offered while unknown");
            // ...but the probe (#4146) connects, learns the server and refuses,
            // so a persistent agent session falls back before its first slice.
            assert!(matches!(ranged.probe().await, Err(FileError::NotSupported)));
            // Real slices are refused too.
            assert!(matches!(
                ranged.read_range("/f.bin", 2, 3).await,
                Err(FileError::NotSupported)
            ));
            assert!(matches!(
                ranged.write_range("/g.bin", 0, b"x").await,
                Err(FileError::NotSupported)
            ));
            assert!(browser.ranged().is_none(), "withheld once known");
            assert_eq!(server.rest_commands(), 0, "never guessed with REST");
            assert!(server.transfers().is_empty());
        }
    }

    #[tokio::test]
    async fn the_probe_confirms_a_server_with_rest_stream() {
        let (server, browser) = mock(MockFtpOptions::default()).await;
        let ranged = browser.ranged().expect("offered while unknown");
        ranged
            .probe()
            .await
            .expect("binary + REST STREAM serves slices");
        assert!(browser.ranged().is_some(), "still offered once known");
        assert_eq!(server.rest_commands(), 0, "the probe moves no data");
        assert!(server.transfers().is_empty());
    }

    #[tokio::test]
    async fn ranged_access_is_learned_on_a_browsing_connect() {
        let (_server, browser) = mock(MockFtpOptions {
            rest: false,
            ..MockFtpOptions::default()
        })
        .await;
        browser.ensure_connected().await.unwrap();
        assert!(browser.ranged().is_none());
    }

    #[test]
    fn ranged_access_is_withheld_for_ascii_transfers() {
        let browser = FtpFileBrowser::new(FtpConfig {
            transfer_type: FtpTransferType::Ascii,
            ..FtpConfig::default()
        });
        assert!(browser.ranged().is_none());
        let binary = FtpFileBrowser::new(FtpConfig::default());
        assert!(binary.ranged().is_some());
    }
}
