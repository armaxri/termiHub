//! The SFTP and Docker ends of a remote→remote copy (#3586): each adapts one
//! backend's streaming primitives to the engine's [`CopyEndpoint`] traits.

use std::io;

use async_trait::async_trait;

use super::{CopyEndpoint, CopyReader, CopyWriter, EndpointLink, OpenError};
use crate::files::transfer::SourceFingerprint;

#[cfg(feature = "ssh")]
pub(super) use sftp::SftpEndpoint;

#[cfg(feature = "docker")]
pub(super) use docker::DockerEndpoint;

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
