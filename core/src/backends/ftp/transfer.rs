//! FTP streaming upload/download — a single, resumable transfer *attempt*
//! (issue #1336).
//!
//! This module owns only the byte-moving I/O for **one** attempt: it opens its
//! own dedicated control+data connection (so concurrent transfers and live
//! browsing never contend on a shared stream), optionally issues `REST
//! <offset>` to resume a partial transfer, then streams the file in fixed
//! chunks. Between chunks it invokes a caller-supplied `on_progress` callback
//! and a `should_stop` probe, so the desktop's queue orchestrator (retry /
//! backoff / pause / cancel / ETA) can live entirely outside `core` and drive
//! this primitive.
//!
//! Streaming (rather than buffering the whole file) is what makes progress,
//! pause, and cancel possible; `suppaftp`'s `retr_as_stream` / `put_with_stream`
//! expose the data connection as an async reader/writer for exactly this.

use std::io::SeekFrom;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::config::FtpConfig;
use crate::errors::SessionError;

use super::establish;

/// Chunk size for the copy loop — large enough to amortise round-trips, small
/// enough that pause/cancel latency stays sub-second.
pub const FTP_CHUNK_SIZE: usize = 256 * 1024;

/// Direction of an FTP transfer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FtpDirection {
    /// Remote → local.
    Download,
    /// Local → remote.
    Upload,
}

/// Why an in-flight attempt stopped short of completion (partial bytes kept).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    /// The user requested a pause; the transfer can resume via `REST`.
    Pause,
    /// The user requested cancellation; the caller cleans up the partial file.
    Cancel,
}

/// Outcome of a single [`run_attempt`] call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttemptOutcome {
    /// The file was transferred to EOF. `transferred` is the total byte count.
    Completed { transferred: u64 },
    /// The `should_stop` probe asked to stop. `transferred` is the byte count
    /// reached so far (usable as a `REST` offset on the next attempt).
    Stopped {
        transferred: u64,
        reason: StopReason,
    },
}

/// Best-effort probe of a remote file's size (`SIZE`), opening a throwaway
/// connection. `None` when the server does not support `SIZE` or the file is
/// unavailable (the caller then renders an indeterminate progress bar).
pub async fn probe_remote_size(config: &FtpConfig, remote_path: &str) -> Option<u64> {
    let mut stream = establish(config).await.ok()?;
    let size = stream.size(remote_path).await.ok().map(|s| s as u64);
    let _ = stream.quit().await;
    size
}

/// Run one FTP transfer attempt on a dedicated connection, resuming from
/// `offset` bytes via `REST` when `offset > 0`.
///
/// - `on_progress(transferred)` is called after each chunk with the cumulative
///   byte count (including `offset`).
/// - `should_stop()` is polled before each chunk; returning `Some(reason)`
///   stops the attempt promptly and yields [`AttemptOutcome::Stopped`].
///
/// I/O or protocol errors bubble up as [`SessionError`]; the caller decides
/// whether to retry (using the bytes already reported via `on_progress`).
pub async fn run_attempt<P, S>(
    config: &FtpConfig,
    direction: FtpDirection,
    remote_path: &str,
    local_path: &str,
    offset: u64,
    on_progress: P,
    should_stop: S,
) -> Result<AttemptOutcome, SessionError>
where
    P: FnMut(u64) + Send,
    S: Fn() -> Option<StopReason> + Send,
{
    let mut stream = establish(config)
        .await
        .map_err(|e| SessionError::SpawnFailed(format!("FTP connect for transfer: {e}")))?;

    if offset > 0 {
        stream
            .resume_transfer(offset as usize)
            .await
            .map_err(|e| SessionError::SpawnFailed(format!("FTP REST {offset}: {e}")))?;
    }

    let outcome = match direction {
        FtpDirection::Download => {
            download(
                &mut stream,
                remote_path,
                local_path,
                offset,
                on_progress,
                should_stop,
            )
            .await
        }
        FtpDirection::Upload => {
            upload(
                &mut stream,
                remote_path,
                local_path,
                offset,
                on_progress,
                should_stop,
            )
            .await
        }
    };

    // Close the control connection best-effort regardless of outcome.
    let _ = stream.quit().await;
    outcome
}

/// Stream a remote file into `local_path`, resuming from `offset`.
async fn download<P, S>(
    stream: &mut super::AsyncRustlsFtpStream,
    remote_path: &str,
    local_path: &str,
    offset: u64,
    mut on_progress: P,
    should_stop: S,
) -> Result<AttemptOutcome, SessionError>
where
    P: FnMut(u64) + Send,
    S: Fn() -> Option<StopReason> + Send,
{
    // Resume appends to the existing partial; a fresh transfer truncates.
    let mut local = if offset > 0 {
        let mut f = tokio::fs::OpenOptions::new()
            .write(true)
            .open(local_path)
            .await?;
        f.seek(SeekFrom::Start(offset)).await?;
        f
    } else {
        tokio::fs::File::create(local_path).await?
    };

    let mut data = stream
        .retr_as_stream(remote_path)
        .await
        .map_err(|e| SessionError::SpawnFailed(format!("FTP RETR: {e}")))?;

    let mut transferred = offset;
    let mut buf = vec![0u8; FTP_CHUNK_SIZE];
    loop {
        if let Some(reason) = should_stop() {
            return Ok(AttemptOutcome::Stopped {
                transferred,
                reason,
            });
        }
        let n = data
            .read(&mut buf)
            .await
            .map_err(|e| SessionError::SpawnFailed(format!("FTP data read: {e}")))?;
        if n == 0 {
            break;
        }
        local.write_all(&buf[..n]).await?;
        transferred += n as u64;
        on_progress(transferred);
    }

    local.flush().await?;
    stream
        .finalize_retr_stream(data)
        .await
        .map_err(|e| SessionError::SpawnFailed(format!("FTP RETR finalize: {e}")))?;
    Ok(AttemptOutcome::Completed { transferred })
}

/// Stream `local_path` to a remote file, resuming from `offset`.
async fn upload<P, S>(
    stream: &mut super::AsyncRustlsFtpStream,
    remote_path: &str,
    local_path: &str,
    offset: u64,
    mut on_progress: P,
    should_stop: S,
) -> Result<AttemptOutcome, SessionError>
where
    P: FnMut(u64) + Send,
    S: Fn() -> Option<StopReason> + Send,
{
    let mut local = tokio::fs::File::open(local_path).await?;
    if offset > 0 {
        local.seek(SeekFrom::Start(offset)).await?;
    }

    let mut data = stream
        .put_with_stream(remote_path)
        .await
        .map_err(|e| SessionError::SpawnFailed(format!("FTP STOR: {e}")))?;

    let mut transferred = offset;
    let mut buf = vec![0u8; FTP_CHUNK_SIZE];
    loop {
        if let Some(reason) = should_stop() {
            // Leave the data stream to drop; the caller cleans up as needed.
            return Ok(AttemptOutcome::Stopped {
                transferred,
                reason,
            });
        }
        let n = local.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        data.write_all(&buf[..n])
            .await
            .map_err(|e| SessionError::SpawnFailed(format!("FTP data write: {e}")))?;
        transferred += n as u64;
        on_progress(transferred);
    }

    data.flush()
        .await
        .map_err(|e| SessionError::SpawnFailed(format!("FTP data flush: {e}")))?;
    stream
        .finalize_put_stream(data)
        .await
        .map_err(|e| SessionError::SpawnFailed(format!("FTP STOR finalize: {e}")))?;
    Ok(AttemptOutcome::Completed { transferred })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direction_is_copy_and_comparable() {
        assert_eq!(FtpDirection::Download, FtpDirection::Download);
        assert_ne!(FtpDirection::Download, FtpDirection::Upload);
    }

    #[test]
    fn stop_reason_variants_distinct() {
        assert_ne!(StopReason::Pause, StopReason::Cancel);
    }

    #[test]
    fn completed_and_stopped_carry_byte_counts() {
        let c = AttemptOutcome::Completed { transferred: 42 };
        let s = AttemptOutcome::Stopped {
            transferred: 10,
            reason: StopReason::Pause,
        };
        assert_ne!(c, s);
        match c {
            AttemptOutcome::Completed { transferred } => assert_eq!(transferred, 42),
            _ => panic!("expected Completed"),
        }
    }
}
