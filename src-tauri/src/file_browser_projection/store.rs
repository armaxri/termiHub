//! The authoritative, client-scoped file-browser **view** state behind the
//! shadow `file-browser@<clientId>` region (#2228, Phase 5 of #2139 / #2153).
//!
//! Models the file-browser UI state the frontend currently drives in
//! `appStore.ts`: the three browser panes a client can open — **local**
//! (`localFileEntries` / `localCurrentPath`), **sftp** (`fileEntries` /
//! `currentPath`) and **session** (`sessionFileEntries` / `sessionCurrentPath`)
//! — which pane is currently active (`fileBrowserMode`), and the copy/cut
//! clipboard (`fileClipboard`). Each pane tracks the directory it is showing,
//! its listing, and whether a directory list is in flight / failed.
//!
//! # Scope — the browser *view*, not the SFTP session model (#2236)
//!
//! This store owns only the **browser view**: which directory each pane shows,
//! its entry listing, the in-flight/error status of a *directory list*, the
//! active pane, and the clipboard. It deliberately does **not** model the
//! backend SFTP/session lifecycle — the live `sftpSessions` map, the SFTP
//! transport connect status (`sftpStatus`), the connected host, or transfers.
//! That backend session model is governed by a separate, pending maintainer
//! decision (`SftpManager` vs `SessionManager`, #2236) and is out of scope here.
//! The line is clean: "is a directory listing in progress for this pane" is a
//! browser-view concern; "is the SFTP transport connected" is the session model.
//! A pane's `loading`/`error` here are the browser's own list-operation flags
//! (mirroring `localFileLoading`/`localFileError` etc.), not the SFTP session
//! status.
//!
//! # Client-scoped — Open Design Decision #4 / #6
//!
//! An open file browser — its current directory, listing, active pane and
//! clipboard — is a property of the *viewing client's* pane, not shared
//! infrastructure. The underlying filesystem / SFTP backend is shared, but the
//! *browser view over it* belongs to the one client looking at it; a second
//! client browsing the same host has its own cwd, selection and clipboard. So —
//! like the client-scoped `layout` ([`crate::layout::projection`]), `broadcast`
//! ([`crate::broadcast_projection`]) and `workflow-run`
//! ([`crate::workflow_projection`]) regions, and unlike the shared
//! `session-lifecycle` region — the store keys everything by `clientId` and
//! projects one `file-browser@<clientId>` region per client.
//!
//! # Shadow only (#2228)
//!
//! Managed authoritative state that serves the `fileBrowser.*` intents, but
//! nothing in the live UI subscribes to or renders the region yet: `appStore`
//! stays authoritative. Later steps cut rendering, then the mutations, over to
//! it, keeping the `appStore` reducers as the parity-safe fallback.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The three file-browser panes a client can open, mirroring the frontend
/// `fileBrowserMode` variants (minus `"none"`, which is the *absence* of an
/// active pane — see [`ClientState::mode`]). Also the `sourceMode` of a
/// clipboard entry.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FileBrowserKind {
    /// The local-filesystem browser (`localFileEntries` / `localCurrentPath`).
    Local,
    /// The SFTP browser (`fileEntries` / `currentPath`).
    Sftp,
    /// The remote-session browser (`sessionFileEntries` / `sessionCurrentPath`).
    Session,
}

/// A copy/cut clipboard operation, mirroring the frontend
/// `FileClipboard.operation`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ClipboardOperation {
    Copy,
    Cut,
}

/// One directory entry, mirroring the frontend `FileEntry` (`connection.ts`).
///
/// Carried verbatim as the pane's listing and inside a clipboard; the store
/// does not interpret the fields beyond passing them through the projected
/// view, so its shape stays a faithful mirror of the frontend type.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub size: u64,
    #[serde(default)]
    pub modified: String,
    #[serde(default)]
    pub permissions: Option<String>,
    #[serde(default)]
    pub writable: Option<bool>,
    #[serde(default)]
    pub is_symlink: bool,
    #[serde(default)]
    pub symlink_target: Option<String>,
}

/// The copy/cut clipboard, mirroring the frontend `FileClipboard`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Clipboard {
    pub entries: Vec<FileEntry>,
    pub operation: ClipboardOperation,
    pub source_mode: FileBrowserKind,
    pub source_path: String,
    #[serde(default)]
    pub sftp_session_id: Option<String>,
    #[serde(default)]
    pub terminal_session_id: Option<String>,
}

/// One browser pane's view: the directory it shows, its listing, and the
/// in-flight/error status of a directory list. Mirrors the per-mode
/// `*FileEntries` / `*CurrentPath` / `*FileLoading` / `*FileError` slice.
#[derive(Clone, Debug, PartialEq)]
struct Pane {
    path: String,
    entries: Vec<FileEntry>,
    loading: bool,
    error: Option<String>,
}

impl Default for Pane {
    /// The idle baseline the frontend seeds each pane with: root path, empty
    /// listing, not loading, no error.
    fn default() -> Self {
        Self {
            path: "/".to_string(),
            entries: Vec::new(),
            loading: false,
            error: None,
        }
    }
}

impl Pane {
    fn to_view(&self) -> Value {
        json!({
            "path": self.path,
            "entries": self.entries,
            "loading": self.loading,
            "error": self.error,
        })
    }
}

/// One client's file-browser view.
#[derive(Clone, Debug, Default)]
struct ClientState {
    /// The active pane, or `None` when no browser is open (`fileBrowserMode`
    /// `"none"`).
    mode: Option<FileBrowserKind>,
    local: Pane,
    sftp: Pane,
    session: Pane,
    /// The copy/cut clipboard, or `None` when empty.
    clipboard: Option<Clipboard>,
}

impl ClientState {
    #[cfg(test)]
    fn pane(&self, kind: FileBrowserKind) -> &Pane {
        match kind {
            FileBrowserKind::Local => &self.local,
            FileBrowserKind::Sftp => &self.sftp,
            FileBrowserKind::Session => &self.session,
        }
    }

    fn pane_mut(&mut self, kind: FileBrowserKind) -> &mut Pane {
        match kind {
            FileBrowserKind::Local => &mut self.local,
            FileBrowserKind::Sftp => &mut self.sftp,
            FileBrowserKind::Session => &mut self.session,
        }
    }

    /// The complete render-ready view model for this client's region.
    fn to_view(&self) -> Value {
        let mode = match self.mode {
            None => "none",
            Some(FileBrowserKind::Local) => "local",
            Some(FileBrowserKind::Sftp) => "sftp",
            Some(FileBrowserKind::Session) => "session",
        };
        json!({
            "mode": mode,
            "local": self.local.to_view(),
            "sftp": self.sftp.to_view(),
            "session": self.session.to_view(),
            "clipboard": self.clipboard,
        })
    }
}

/// The shadow file-browser authority. Owns one [`ClientState`] per attached
/// client, keyed by `clientId`; an unknown client is seeded lazily on first
/// touch. Each client projects its own `file-browser@<clientId>` region.
pub struct FileBrowserStore {
    clients: Mutex<HashMap<String, ClientState>>,
}

impl Default for FileBrowserStore {
    fn default() -> Self {
        Self::new()
    }
}

impl FileBrowserStore {
    /// A store with no clients yet. Regions are seeded lazily per `clientId`.
    pub fn new() -> Self {
        Self {
            clients: Mutex::new(HashMap::new()),
        }
    }

    /// The current render-ready view model for a client (seeding it if
    /// unknown): `{ mode, local, sftp, session, clipboard }`.
    ///
    /// Pure with respect to browser state (never mutates beyond lazy seeding of
    /// an empty client), so the projector can safely diff two consecutive
    /// snapshots.
    pub fn snapshot(&self, client_id: &str) -> Value {
        self.lock()
            .entry(client_id.to_string())
            .or_default()
            .to_view()
    }

    /// `fileBrowser.setMode` — set the active browser pane (mirroring
    /// `setFileBrowserMode`). `None` is the frontend `"none"` (no browser open).
    pub fn set_mode(&self, client_id: &str, mode: Option<FileBrowserKind>) {
        let mut clients = self.lock();
        clients.entry(client_id.to_string()).or_default().mode = mode;
    }

    /// `fileBrowser.loadStarted` — a directory list began for a pane: mark it
    /// loading and clear its error (mirroring the `set({ *Loading: true,
    /// *Error: null })` at the head of `navigate*` / `refresh*`).
    pub fn load_started(&self, client_id: &str, pane: FileBrowserKind) {
        let mut clients = self.lock();
        let p = clients
            .entry(client_id.to_string())
            .or_default()
            .pane_mut(pane);
        p.loading = true;
        p.error = None;
    }

    /// `fileBrowser.loadSucceeded` — a directory list completed for a pane:
    /// commit the listing and path and clear loading (mirroring the success
    /// `set({ *FileEntries, *CurrentPath, *Loading: false })`). This is the
    /// `setEntries` seam.
    pub fn load_succeeded(
        &self,
        client_id: &str,
        pane: FileBrowserKind,
        path: &str,
        entries: Vec<FileEntry>,
    ) {
        let mut clients = self.lock();
        let p = clients
            .entry(client_id.to_string())
            .or_default()
            .pane_mut(pane);
        p.path = path.to_string();
        p.entries = entries;
        p.loading = false;
        p.error = None;
    }

    /// `fileBrowser.loadFailed` — a directory list failed for a pane: clear
    /// loading and record the error, leaving the last-good path/listing in place
    /// (mirroring the `catch` `set({ *Loading: false, *Error })`).
    pub fn load_failed(&self, client_id: &str, pane: FileBrowserKind, error: Option<String>) {
        let mut clients = self.lock();
        let p = clients
            .entry(client_id.to_string())
            .or_default()
            .pane_mut(pane);
        p.loading = false;
        p.error = error;
    }

    /// `fileBrowser.reset` — reset a pane to the idle baseline (root path, empty
    /// listing, not loading, no error), mirroring the `set({ *FileEntries: [],
    /// *CurrentPath: "/" })` resets on disconnect / tab close.
    pub fn reset_pane(&self, client_id: &str, pane: FileBrowserKind) {
        let mut clients = self.lock();
        *clients
            .entry(client_id.to_string())
            .or_default()
            .pane_mut(pane) = Pane::default();
    }

    /// `fileBrowser.setClipboard` — set or clear the copy/cut clipboard
    /// (mirroring `setFileClipboard`).
    pub fn set_clipboard(&self, client_id: &str, clipboard: Option<Clipboard>) {
        let mut clients = self.lock();
        clients.entry(client_id.to_string()).or_default().clipboard = clipboard;
    }

    /// Read a pane's `(path, entry_count, loading)` (test/diagnostics helper).
    #[cfg(test)]
    pub fn pane_state(
        &self,
        client_id: &str,
        pane: FileBrowserKind,
    ) -> Option<(String, usize, bool)> {
        self.lock().get(client_id).map(|s| {
            let p = s.pane(pane);
            (p.path.clone(), p.entries.len(), p.loading)
        })
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, ClientState>> {
        // Short critical sections only; a poisoned lock means another thread
        // panicked mid-mutation (a bug) — recover rather than cascade.
        self.clients.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
