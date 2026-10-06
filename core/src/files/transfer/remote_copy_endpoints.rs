//! The SFTP, Docker and ranged ends of a remote→remote copy (#3586, #4115):
//! each adapts one backend's primitives to the engine's [`CopyEndpoint`]
//! traits.

use std::io;

use async_trait::async_trait;

use super::{CopyEndpoint, CopyReader, CopyWriter, EndpointLink, OpenError};
use crate::files::transfer::SourceFingerprint;

#[cfg(feature = "ssh")]
pub(super) use sftp::SftpEndpoint;

#[cfg(feature = "docker")]
pub(super) use docker::DockerEndpoint;

#[cfg(feature = "local-transfer")]
pub(super) use ranged::RangedEndpoint;

#[cfg(feature = "ssh")]
mod sftp {
    use std::sync::Arc;

    use russh_sftp::client::fs::File;
    use tokio::io::AsyncWriteExt;
    use tracing::debug;

    use super::*;
    use crate::backends::ssh::{SftpFileBrowser, SftpTransferChannel};

    /// An SFTP session: each attempt opens its own dedicated channel, so the
    /// browsing session stays live and a broken channel is re-established on
    /// retry.
    pub(in crate::files::transfer::remote_copy) struct SftpEndpoint {
        browser: Arc<SftpFileBrowser>,
    }

    impl SftpEndpoint {
        pub(in crate::files::transfer::remote_copy) fn new(browser: Arc<SftpFileBrowser>) -> Self {
            Self { browser }
        }
    }

    #[async_trait]
    impl CopyEndpoint for SftpEndpoint {
        fn peer(&self) -> &'static str {
            "server"
        }

        fn error_prefix(&self) -> &'static str {
            "SSH error"
        }

        async fn link(&self) -> Result<Box<dyn EndpointLink>, String> {
            let channel = self
                .browser
                .open_dedicated_channel()
                .await
                .map_err(|e| format!("SFTP transfer channel: {e}"))?;
            Ok(Box::new(SftpLink { channel }))
        }

        async fn remove_partial(&self, path: &str) {
            match self.browser.open_dedicated_channel().await {
                Ok(ch) => {
                    if let Err(e) = ch.remove_file(path).await {
                        debug!(error = %e, "could not remove partial remote-to-remote copy (best-effort)");
                    }
                }
                Err(e) => {
                    debug!(error = %e, "could not open channel to clean partial remote-to-remote copy")
                }
            }
        }
    }

    struct SftpLink {
        channel: SftpTransferChannel,
    }

    #[async_trait]
    impl EndpointLink for SftpLink {
        async fn fingerprint(&self, path: &str) -> Option<SourceFingerprint> {
            self.channel.remote_fingerprint(path).await
        }

        async fn file_size(&self, path: &str) -> Option<u64> {
            self.channel.remote_file_size(path).await
        }

        fn can_resume_read(&self) -> bool {
            true
        }

        fn can_resume_write(&self) -> bool {
            true
        }

        async fn open_read(
            &self,
            path: &str,
            offset: u64,
        ) -> Result<Box<dyn CopyReader>, OpenError> {
            match self.channel.open_read_at(path, offset).await {
                Ok(file) => Ok(Box::new(file)),
                // A server refusing the seek → restart from zero.
                Err(e) if offset > 0 => Err(OpenError::ResumeRejected(e.to_string())),
                Err(e) => Err(OpenError::Failed(format!("open source file: {e}"))),
            }
        }

        async fn open_write(
            &self,
            path: &str,
            offset: u64,
        ) -> Result<Box<dyn CopyWriter>, OpenError> {
            if offset > 0 {
                // Append (no truncate) at the byte-verified offset.
                return match self.channel.open_write_at(path, offset).await {
                    Ok(file) => Ok(Box::new(file)),
                    Err(e) => Err(OpenError::ResumeRejected(e.to_string())),
                };
            }
            self.channel
                .create_write(path)
                .await
                .map(|file| Box::new(file) as Box<dyn CopyWriter>)
                .map_err(|e| OpenError::Failed(format!("create destination file: {e}")))
        }
    }

    #[async_trait]
    impl CopyReader for File {
        async fn finish(self: Box<Self>) -> io::Result<()> {
            // SFTP reads carry no exit status; EOF is the end of the file.
            Ok(())
        }
    }

    #[async_trait]
    impl CopyWriter for File {
        async fn finish(mut self: Box<Self>) -> io::Result<()> {
            // Close the handle so every pipelined write is acknowledged.
            self.shutdown().await
        }
    }
}

#[cfg(feature = "docker")]
mod docker {
    use tokio::sync::OnceCell;
    use tracing::info;

    use super::*;
    use crate::backends::docker::{ContainerCaps, DockerTransferTarget, ExecReader, ExecWriter};

    /// A Docker session: each operation runs its own `docker exec`, so browsing
    /// stays live and a killed exec is simply retried. The container's tools
    /// are probed once per copy.
    pub(in crate::files::transfer::remote_copy) struct DockerEndpoint {
        target: DockerTransferTarget,
        caps: OnceCell<ContainerCaps>,
    }

    impl DockerEndpoint {
        pub(in crate::files::transfer::remote_copy) fn new(target: DockerTransferTarget) -> Self {
            Self {
                target,
                caps: OnceCell::new(),
            }
        }

        /// Probe the container's streaming tools; a container without `cat`
        /// cannot stream at all.
        async fn probe(&self) -> Result<ContainerCaps, String> {
            let probed = self
                .target
                .probe()
                .await
                .map_err(|e| format!("probe container tools: {e}"))?;
            if !probed.cat {
                return Err("container has no `cat`; streaming transfer unavailable".to_string());
            }
            info!(
                container = self.target.container_id(),
                ?probed,
                "Docker copy tools probed"
            );
            Ok(probed)
        }
    }

    #[async_trait]
    impl CopyEndpoint for DockerEndpoint {
        fn peer(&self) -> &'static str {
            "container"
        }

        fn error_prefix(&self) -> &'static str {
            "Docker error"
        }

        async fn link(&self) -> Result<Box<dyn EndpointLink>, String> {
            let caps = *self.caps.get_or_try_init(|| self.probe()).await?;
            Ok(Box::new(DockerLink {
                target: self.target.clone(),
                caps,
            }))
        }

        async fn remove_partial(&self, path: &str) {
            if let Err(e) = self.target.remove_file(path).await {
                tracing::debug!(error = %e, "could not remove partial Docker copy (best-effort)");
            }
        }
    }

    struct DockerLink {
        target: DockerTransferTarget,
        caps: ContainerCaps,
    }

    #[async_trait]
    impl EndpointLink for DockerLink {
        async fn fingerprint(&self, path: &str) -> Option<SourceFingerprint> {
            if self.caps.stat {
                self.target.fingerprint(path).await
            } else {
                None
            }
        }

        async fn file_size(&self, path: &str) -> Option<u64> {
            self.target.file_size(path).await
        }

        /// `tail -c +N` to read from the offset **and** `stat` to prove the
        /// container-side source is unchanged.
        fn can_resume_read(&self) -> bool {
            self.caps.offset_read && self.caps.stat
        }

        /// `wc -c` to measure the container-side partial.
        fn can_resume_write(&self) -> bool {
            self.caps.size
        }

        async fn open_read(
            &self,
            path: &str,
            offset: u64,
        ) -> Result<Box<dyn CopyReader>, OpenError> {
            self.target
                .open_read(path, offset)
                .await
                .map(|r| Box::new(r) as Box<dyn CopyReader>)
                .map_err(|e| OpenError::Failed(format!("open container file: {e}")))
        }

        async fn open_write(
            &self,
            path: &str,
            offset: u64,
        ) -> Result<Box<dyn CopyWriter>, OpenError> {
            self.target
                .open_write(path, offset > 0)
                .await
                .map(|w| Box::new(w) as Box<dyn CopyWriter>)
                .map_err(|e| OpenError::Failed(format!("open container file: {e}")))
        }
    }

    #[async_trait]
    impl CopyReader for ExecReader {
        async fn finish(self: Box<Self>) -> io::Result<()> {
            // EOF alone proves nothing: a killed `cat`/`tail` also ends stdout.
            // Only a clean exit means the whole file arrived.
            ExecReader::finish(*self).await.map_err(io::Error::other)
        }
    }

    #[async_trait]
    impl CopyWriter for ExecWriter {
        async fn finish(self: Box<Self>) -> io::Result<()> {
            // Close stdin and wait for `cat` to exit 0: only then is the file
            // complete in the container.
            ExecWriter::finish(*self).await.map_err(io::Error::other)
        }
    }
}

/// An end reached only through offset-addressed slices ([`RangedFileAccess`]):
/// an agent-hosted session (#4115). Every read and write is one
/// self-contained request of at most [`MAX_RANGE_BYTES`], so the copy needs
/// no long-lived stream on the far side.
///
/// [`RangedFileAccess`]: crate::files::RangedFileAccess
/// [`MAX_RANGE_BYTES`]: crate::files::MAX_RANGE_BYTES
#[cfg(feature = "local-transfer")]
mod ranged {
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::Arc;
    use std::task::{ready, Context, Poll};

    use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, ReadBuf};
    use tokio::sync::OnceCell;
    use tracing::debug;

    use super::*;
    use crate::errors::FileError;
    use crate::files::transfer::ranged::{remote_fingerprint, RangedTransferTarget};
    use crate::files::MAX_RANGE_BYTES;

    /// One slice request in flight.
    type Pending<T> = Pin<Box<dyn Future<Output = Result<T, FileError>> + Send>>;

    /// The size of one slice: the transfer chunk size.
    const SLICE: usize = MAX_RANGE_BYTES as usize;

    fn io_err(e: FileError) -> io::Error {
        io::Error::other(e.to_string())
    }

    /// A ranged session. Its slice support is probed once per copy
    /// ([`RangedFileAccess::probe`](crate::files::RangedFileAccess::probe)),
    /// so a session that cannot serve slices fails the attempt with a clear
    /// reason instead of on its first slice.
    pub(in crate::files::transfer::remote_copy) struct RangedEndpoint {
        target: Arc<dyn RangedTransferTarget>,
        probed: OnceCell<()>,
    }

    impl RangedEndpoint {
        pub(in crate::files::transfer::remote_copy) fn new(
            target: Arc<dyn RangedTransferTarget>,
        ) -> Self {
            Self {
                target,
                probed: OnceCell::new(),
            }
        }
    }

    #[async_trait]
    impl CopyEndpoint for RangedEndpoint {
        fn peer(&self) -> &'static str {
            "agent"
        }

        fn error_prefix(&self) -> &'static str {
            "Agent error"
        }

        async fn link(&self) -> Result<Box<dyn EndpointLink>, String> {
            self.probed
                .get_or_try_init(|| async {
                    self.target
                        .probe()
                        .await
                        .map_err(|e| format!("ranged file access unavailable: {e}"))
                })
                .await?;
            Ok(Box::new(RangedLink {
                target: self.target.clone(),
            }))
        }

        async fn remove_partial(&self, path: &str) {
            if let Err(e) = self.target.remove_file(path).await {
                debug!(error = %e, "could not remove partial ranged copy (best-effort)");
            }
        }
    }

    /// One attempt's access to a ranged end. Slices are stateless, so an
    /// attempt holds nothing but the target.
    struct RangedLink {
        target: Arc<dyn RangedTransferTarget>,
    }

    #[async_trait]
    impl EndpointLink for RangedLink {
        async fn fingerprint(&self, path: &str) -> Option<SourceFingerprint> {
            remote_fingerprint(self.target.as_ref(), path).await
        }

        async fn file_size(&self, path: &str) -> Option<u64> {
            self.target.stat(path).await.ok().map(|entry| entry.size)
        }

        /// Every slice names its offset, and `stat` fingerprints the source.
        fn can_resume_read(&self) -> bool {
            true
        }

        /// `stat` measures the partial, and every write states the offset it
        /// expects, so a chunk can never land in the wrong place.
        fn can_resume_write(&self) -> bool {
            true
        }

        async fn open_read(
            &self,
            path: &str,
            offset: u64,
        ) -> Result<Box<dyn CopyReader>, OpenError> {
            Ok(Box::new(RangedReader {
                target: self.target.clone(),
                path: Arc::from(path),
                next: offset,
                buf: Vec::new(),
                pos: 0,
                eof: false,
                pending: None,
            }))
        }

        async fn open_write(
            &self,
            path: &str,
            offset: u64,
        ) -> Result<Box<dyn CopyWriter>, OpenError> {
            Ok(Box::new(RangedWriter {
                target: self.target.clone(),
                path: Arc::from(path),
                landed: offset,
                staged: Vec::with_capacity(SLICE),
                in_flight: None,
                created: offset > 0,
            }))
        }
    }

    /// Reads a ranged source one slice at a time. A short slice is the end
    /// of the file.
    struct RangedReader {
        target: Arc<dyn RangedTransferTarget>,
        path: Arc<str>,
        /// Offset of the next slice to request.
        next: u64,
        /// The current slice and how much of it was handed out.
        buf: Vec<u8>,
        pos: usize,
        eof: bool,
        pending: Option<Pending<Vec<u8>>>,
    }

    impl AsyncRead for RangedReader {
        fn poll_read(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            out: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            let this = &mut *self;
            loop {
                if this.pos < this.buf.len() {
                    let n = (this.buf.len() - this.pos).min(out.remaining());
                    out.put_slice(&this.buf[this.pos..this.pos + n]);
                    this.pos += n;
                    return Poll::Ready(Ok(()));
                }
                if this.eof || out.remaining() == 0 {
                    return Poll::Ready(Ok(()));
                }
                let fut = this.pending.get_or_insert_with(|| {
                    let (target, path, offset) =
                        (this.target.clone(), this.path.clone(), this.next);
                    Box::pin(async move { target.read_range(&path, offset, MAX_RANGE_BYTES).await })
                });
                let result = ready!(fut.as_mut().poll(cx));
                this.pending = None;
                let slice = result.map_err(io_err)?;
                this.next += slice.len() as u64;
                this.eof = slice.len() < SLICE;
                this.buf = slice;
                this.pos = 0;
            }
        }
    }

    #[async_trait]
    impl CopyReader for RangedReader {
        async fn finish(self: Box<Self>) -> io::Result<()> {
            // Every slice was its own complete request; nothing to settle.
            Ok(())
        }
    }

    /// Writes a ranged destination one slice at a time: bytes are staged
    /// until a full slice is ready (or the stream is flushed), then sent as
    /// one `write_range` at the offset the destination must already hold.
    struct RangedWriter {
        target: Arc<dyn RangedTransferTarget>,
        path: Arc<str>,
        /// Bytes confirmed at the destination.
        landed: u64,
        staged: Vec<u8>,
        /// The slice being written and its length.
        in_flight: Option<(Pending<()>, usize)>,
        /// Whether the destination exists: a resumed write appends to the
        /// partial; a fresh one must create (truncate) it even when the
        /// source is empty.
        created: bool,
    }

    impl RangedWriter {
        /// Drive the slice in flight, if any, to completion.
        fn poll_in_flight(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            if let Some((fut, len)) = self.in_flight.as_mut() {
                let result = ready!(fut.as_mut().poll(cx));
                let len = *len;
                self.in_flight = None;
                result.map_err(io_err)?;
                self.landed += len as u64;
                self.created = true;
            }
            Poll::Ready(Ok(()))
        }

        /// Send the staged bytes as one slice at the landed offset.
        fn send_staged(&mut self) {
            let data = std::mem::replace(&mut self.staged, Vec::with_capacity(SLICE));
            let len = data.len();
            let (target, path, offset) = (self.target.clone(), self.path.clone(), self.landed);
            self.in_flight = Some((
                Box::pin(async move { target.write_range(&path, offset, &data).await }),
                len,
            ));
        }
    }

    impl AsyncWrite for RangedWriter {
        fn poll_write(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            data: &[u8],
        ) -> Poll<io::Result<usize>> {
            let this = &mut *self;
            ready!(this.poll_in_flight(cx))?;
            if this.staged.len() >= SLICE {
                this.send_staged();
                ready!(this.poll_in_flight(cx))?;
            }
            let n = (SLICE - this.staged.len()).min(data.len());
            this.staged.extend_from_slice(&data[..n]);
            Poll::Ready(Ok(n))
        }

        fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            let this = &mut *self;
            loop {
                ready!(this.poll_in_flight(cx))?;
                if this.staged.is_empty() && this.created {
                    return Poll::Ready(Ok(()));
                }
                // An empty slice at offset 0 creates an empty destination.
                this.send_staged();
            }
        }

        fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            self.poll_flush(cx)
        }
    }

    #[async_trait]
    impl CopyWriter for RangedWriter {
        async fn finish(mut self: Box<Self>) -> io::Result<()> {
            // Send whatever is still staged: only then have the counted bytes
            // landed.
            self.flush().await
        }
    }
}
