//! File-operation seam for [`SessionManager`] (ARCH-002 / TAURI-009).
//!
//! Carved out of `session/manager.rs` as a behavior-preserving prod slice: the
//! cohesive SFTP / file-browser family (`list_files`, `read_file`, `stat_file`,
//! `write_file`, `delete_file`, `rename_file`, `mkdir_file`,
//! `set_file_permissions`, and the session-scoped SFTP advanced ops /
//! transfers) lives here in a second `impl SessionManager` block. Signatures,
//! visibility, and behavior are unchanged; the block reaches the struct's
//! fields exactly as before because this is a submodule of `session::manager`.

use std::sync::Arc;

use termihub_core::backends::ssh::SftpFileBrowser;
use termihub_core::files::FileEntry;

use crate::files::sftp::{ElevatedWriteResult, Writability};
use crate::session::file_ops::FileOps;
use crate::utils::errors::TerminalError;

use super::SessionManager;

impl SessionManager {
    /// Borrow a [`FileOps`] facade over this manager's sessions (#2076).
    ///
    /// The facade is stateless — it holds only a borrow of the `sessions` map —
    /// so the public `*_file` methods below construct one per call and forward
    /// to it. This keeps the file-browser plumbing out of the manager while
    /// leaving the public API and behavior unchanged.
    fn file_ops(&self) -> FileOps<'_> {
        FileOps::new(&self.sessions)
    }

    /// List directory contents via a session's file browser capability.
    pub async fn list_files(
        &self,
        session_id: &str,
        path: &str,
    ) -> Result<Vec<FileEntry>, TerminalError> {
        self.file_ops().list_dir(session_id, path).await
    }

    /// Read a file via a session's file browser capability.
    pub async fn read_file(&self, session_id: &str, path: &str) -> Result<Vec<u8>, TerminalError> {
        self.file_ops().read_file(session_id, path).await
    }

    /// Get metadata for a single file via a session's file browser capability.
    ///
    /// Backs the editor's remote external-change detection (#1627): the frontend
    /// polls this to compare `modified`/`size` against the last-seen values. It
    /// routes through the same `connection.files.stat` RPC the file browser
    /// already uses — no new protocol.
    pub async fn stat_file(
        &self,
        session_id: &str,
        path: &str,
    ) -> Result<FileEntry, TerminalError> {
        self.file_ops().stat(session_id, path).await
    }

    /// Write a file via a session's file browser capability.
    pub async fn write_file(
        &self,
        session_id: &str,
        path: &str,
        data: &[u8],
    ) -> Result<(), TerminalError> {
        self.file_ops().write_file(session_id, path, data).await
    }

    /// Delete a file via a session's file browser capability.
    pub async fn delete_file(&self, session_id: &str, path: &str) -> Result<(), TerminalError> {
        self.file_ops().delete(session_id, path).await
    }

    /// Rename a file via a session's file browser capability.
    pub async fn rename_file(
        &self,
        session_id: &str,
        from: &str,
        to: &str,
    ) -> Result<(), TerminalError> {
        self.file_ops().rename(session_id, from, to).await
    }

    /// Create a directory via a session's file browser capability.
    pub async fn mkdir_file(&self, session_id: &str, path: &str) -> Result<(), TerminalError> {
        self.file_ops().mkdir(session_id, path).await
    }

    /// Change the permission bits (chmod) of a file via a session's file browser
    /// capability. `mode` is the low 12 bits of a Unix mode (e.g. `0o755`).
    pub async fn set_file_permissions(
        &self,
        session_id: &str,
        path: &str,
        mode: u32,
    ) -> Result<(), TerminalError> {
        self.file_ops()
            .set_permissions(session_id, path, mode)
            .await
    }

    /// Change the owner/group (chown) of a file via a session's file browser
    /// capability. A `None` id leaves that side unchanged.
    pub async fn set_file_owner(
        &self,
        session_id: &str,
        path: &str,
        uid: Option<u32>,
        gid: Option<u32>,
    ) -> Result<(), TerminalError> {
        self.file_ops().set_owner(session_id, path, uid, gid).await
    }

    /// Create a symlink at `link_path` pointing at `target` via a session's file
    /// browser capability.
    pub async fn create_file_symlink(
        &self,
        session_id: &str,
        target: &str,
        link_path: &str,
    ) -> Result<(), TerminalError> {
        self.file_ops()
            .create_symlink(session_id, target, link_path)
            .await
    }

    /// Copy `src` → `dest` within a session's backend (same-backend copy).
    pub async fn copy_file(
        &self,
        session_id: &str,
        src: &str,
        dest: &str,
    ) -> Result<(), TerminalError> {
        self.file_ops().copy(session_id, src, dest).await
    }

    // --- Session-scoped SFTP advanced operations & transfers (#2312) ---
    //
    // These reach the SSH-specific SFTP capabilities that do not fit on the shared
    // `FileBrowser` trait (realpath / writability probe / elevated write / exec
    // probe) and hand out an owned transfer handle, so a session-backed SSH
    // connection can drive the same advanced ops and cancellable transfers the
    // standalone `sftp_*` path offers. They only succeed for an SFTP-backed
    // session; other backends get a "not supported" `RemoteError`.

    /// Resolve a remote path to its canonical absolute form via a session's SFTP
    /// realpath (session-path mirror of `sftp_realpath`, #2312).
    pub async fn session_realpath(
        &self,
        session_id: &str,
        path: &str,
    ) -> Result<String, TerminalError> {
        self.file_ops().realpath(session_id, path).await
    }

    /// Authoritatively probe whether a remote file is writable by the connecting
    /// user via a session's SFTP write-open probe (session-path mirror of
    /// `sftp_check_writable`, #2312).
    pub async fn session_check_writable(
        &self,
        session_id: &str,
        remote_path: &str,
    ) -> Result<Writability, TerminalError> {
        self.file_ops()
            .check_writable(session_id, remote_path)
            .await
    }

    /// Write `content` to `remote_path` with `sudo`-elevated privileges over a
    /// session's SFTP connection (session-path mirror of
    /// `sftp_write_file_content_elevated`, #2312).
    pub async fn session_write_file_elevated(
        &self,
        session_id: &str,
        remote_path: &str,
        content: &str,
        sudo_password: &str,
    ) -> Result<ElevatedWriteResult, TerminalError> {
        self.file_ops()
            .write_file_elevated(session_id, remote_path, content, sudo_password)
            .await
    }

    /// Report whether a session's SFTP connection can open an exec channel
    /// (session-path mirror of `sftp_has_exec_capability`, #2312).
    pub async fn session_has_exec_capability(
        &self,
        session_id: &str,
    ) -> Result<bool, TerminalError> {
        self.file_ops().has_exec_capability(session_id).await
    }

    /// Resolve an owned [`Arc<SftpFileBrowser>`] for a session so a cancellable
    /// background transfer can own its channel independently of the sessions lock
    /// (#1245/#2312). See [`FileOps::sftp_browser`](crate::session::file_ops).
    pub async fn sftp_transfer_browser(
        &self,
        session_id: &str,
    ) -> Result<Arc<SftpFileBrowser>, TerminalError> {
        self.file_ops().sftp_browser(session_id).await
    }
}
