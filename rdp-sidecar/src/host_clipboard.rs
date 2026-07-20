//! Reading the host OS clipboard's native **file list** (#1779).
//!
//! The sidecar runs as a child process on the same machine as the user, so it
//! can read the host operating system's clipboard directly. When the user copies
//! files in their native file manager (Explorer / Finder / a Linux file manager),
//! the OS clipboard holds a platform-specific file list —
//! [`CF_HDROP`](https://learn.microsoft.com/windows/win32/shell/clipboard#cf_hdrop)
//! on Windows, `NSFilenamesPboardType` / file URLs on macOS, `text/uri-list` on
//! X11 / Wayland. [`SidecarClipboardBackend`](crate::clipboard::SidecarClipboardBackend)
//! bridges those real files to the remote over CLIPRDR so they can be pasted into
//! the remote session, not just files staged in the sandboxed shared folder
//! (#1778).
//!
//! ## Platform coverage
//!
//! This module currently reads the **macOS** pasteboard (via the `clipboard-files`
//! crate, which asks `NSPasteboard` for file URLs). Windows (`CF_HDROP`) and Linux
//! (`text/uri-list`) reading are sequenced follow-ups: on those platforms the
//! reader returns an empty list, so the backend simply falls back to the #1778
//! sandboxed-shared-folder offer — the feature degrades per platform rather than
//! breaking. Keeping the platform reader behind this one function means adding a
//! platform is a single-function change.
//!
//! `clipboard-files` is intentionally pulled in **only for macOS** (see the
//! sidecar `Cargo.toml`): its Linux path links `gtk` and its Windows path links
//! `clipboard-win`, and dragging those into the Linux/Windows sidecar builds
//! before those platforms are wired would be pure cost. This crate lives in the
//! workspace-**excluded** sidecar graph, so the dependency adds zero
//! conflict risk to the main app (#1747).

use std::path::PathBuf;

#[cfg_attr(not(target_os = "macos"), allow(unused_imports))]
use tracing::{debug, warn};

/// Absolute paths of the files currently on the host OS clipboard's native file
/// list.
///
/// Returns an **empty** list when the clipboard holds no file list — it is text,
/// an image, or empty — and on any platform whose reader is not yet implemented.
/// An empty result is the "nothing to offer" signal the backend uses to fall back
/// to the sandboxed shared folder, so a read failure is logged and swallowed
/// rather than surfaced: a broken clipboard read must never tear down the session.
#[cfg(target_os = "macos")]
pub fn read_host_clipboard_files() -> Vec<PathBuf> {
    match clipboard_files::read() {
        Ok(paths) => {
            debug!(count = paths.len(), "read host clipboard file list");
            paths
        }
        // The clipboard simply holds no files (text / image / empty) — expected,
        // not an error.
        Err(clipboard_files::Error::NoFiles) => Vec::new(),
        Err(clipboard_files::Error::SystemError(e)) => {
            warn!(error = %e, "failed to read host clipboard file list; offering none");
            Vec::new()
        }
    }
}

/// Windows (`CF_HDROP`) and Linux (`text/uri-list`) readers are sequenced
/// follow-ups; until then these platforms offer no host-clipboard files and the
/// backend falls back to the sandboxed shared folder (#1778).
#[cfg(not(target_os = "macos"))]
pub fn read_host_clipboard_files() -> Vec<PathBuf> {
    Vec::new()
}
