//! Native Linux clipboard binding for pasting remote-copied RDP clipboard files
//! into local apps with **delayed rendering** (#1815 X11, #1847 Wayland).
//!
//! The Linux sibling of [`crate::macos_clipboard`] (`NSPasteboard`, #1804) and
//! `crate::windows_clipboard` (`CF_HDROP`, #1814): the RDP sidecar surfaces the
//! list of files the remote copied (`GraphicalBackend::remote_clipboard_files`)
//! and streams a file's bytes on demand (`fetch_remote_clipboard_file`); this
//! module binds that transport to the host's clipboard, serving the file list as
//! `text/uri-list` (plus the `x-special/gnome-copied-files` /
//! `x-special/mate-copied-files` variants file managers expect) so the copied
//! files can be pasted into Files/Nautilus, Nemo, Caja, Dolphin, or any local app.
//!
//! ## Two selection systems, one delayed contract
//!
//! Linux desktops run one of two clipboard systems, and a native app reads from
//! exactly one of them:
//!
//! - **X11 `CLIPBOARD` selection** ([`x11`]) — every X11 app, and (under a Wayland
//!   session) every app bridged through **XWayland**. Delayed rendering here means
//!   owning the selection and answering `SelectionRequest` conversions on paste.
//! - **Wayland `wlr-data-control`** ([`wayland`]) — native-only Wayland clients
//!   that read solely over the compositor's data-control protocol and never touch
//!   XWayland. Delayed rendering here means owning a data source and serving its
//!   `send` callback on paste.
//!
//! Both paths honour the same contract: **no bytes move on copy**. The promised
//! files are fetched from the remote (one at a time, into sanitized bounded temp
//! files) only when a paste actually requests one of our targets, via the shared
//! [`fetch_and_render`]. RAM stays bounded to whatever a single fetch stages.
//!
//! ## Runtime path selection (#1847)
//!
//! [`bind_remote_clipboard_files`] binds **whichever systems the session exposes**,
//! so a copy is pasteable regardless of which clipboard a given local app reads:
//!
//! - On a **Wayland session** (`WAYLAND_DISPLAY` set) it installs the native
//!   [`wayland`] delayed source, so native-only Wayland file managers see the
//!   files. It *also* installs the [`x11`] owner when an X server is reachable
//!   (`DISPLAY` set — i.e. XWayland is running), so XWayland-bridged apps keep
//!   working exactly as under #1815.
//! - On a pure **X11 session** it installs only the [`x11`] owner.
//!
//! A bind succeeds if **either** system was bound. The Wayland setup failing (an
//! older compositor with no `wlr-data-control`, e.g.) degrades to the X11/XWayland
//! path rather than erroring, so nothing regresses relative to #1815.
//!
//! Everything here is `#[cfg(target_os = "linux")]`-gated at the module
//! declaration in `lib.rs`. On a platform with no binding `clipboard_delayed_render`
//! stays off and the eager shared-folder download (#1765) remains the behaviour.

mod wayland;
mod x11;

use std::os::unix::ffi::OsStrExt;
use std::path::Path;

use percent_encoding::{percent_encode, AsciiSet, NON_ALPHANUMERIC};
use tauri::AppHandle;

use crate::session::graphical_manager::GraphicalSessionManager;
use termihub_core::connection::RemoteClipboardFile;

/// Percent-encoding set for a `file://` URI path: everything that is not an RFC
/// 3986 *unreserved* character (`ALPHA` / `DIGIT` / `-` / `.` / `_` / `~`) is
/// encoded, except `/`, which stays literal as the path separator. This matches
/// what file managers emit and what the sidecar's `parse_uri_list` percent-decodes
/// on the read side.
const PATH_ENCODE_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'/')
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

/// The advertised indices of the files worth offering to the OS clipboard — the
/// regular files, in order. Directories carry no bytes to fetch (they are
/// surfaced only so a copied tree can be recreated), so they are dropped.
///
/// Pure and display-free so the selection logic is unit-testable without a
/// display or compositor.
fn pasteable_indices(files: &[RemoteClipboardFile]) -> Vec<u32> {
    files
        .iter()
        .filter(|f| !f.is_dir)
        .map(|f| f.index)
        .collect()
}

/// Converts an absolute local `path` to a percent-encoded `file://` URI.
///
/// The raw path **bytes** are encoded (via [`std::os::unix::ffi::OsStrExt`]) so a
/// non-UTF-8 or non-ASCII filename survives losslessly as the UTF-8/byte sequence
/// its percent-encoding represents. An absolute path begins with `/`, so the
/// result is the empty-authority form `file:///abs/path`.
///
/// Pure over a path so the encoding is unit-testable without a display; the caller
/// passes the sidecar-staged temp path.
fn path_to_file_uri(path: &Path) -> String {
    let encoded = percent_encode(path.as_os_str().as_bytes(), PATH_ENCODE_SET);
    format!("file://{encoded}")
}

/// Builds a `text/uri-list` payload (RFC 2483): one `file://` URI per line,
/// CRLF-terminated. The inverse of the sidecar's `parse_uri_list`.
///
/// Pure so the format is unit-testable without a display.
fn build_uri_list(uris: &[String]) -> Vec<u8> {
    let mut out = String::new();
    for uri in uris {
        out.push_str(uri);
        out.push_str("\r\n");
    }
    out.into_bytes()
}

/// Builds an `x-special/gnome-copied-files` / `x-special/mate-copied-files`
/// payload: the literal first line `copy` (a copy, never a cut), then one
/// `file://` URI per line, `\n`-separated with **no** trailing newline — the form
/// Nautilus, Nemo, and Caja expect.
///
/// Pure so the format is unit-testable without a display.
fn build_gnome_copied_files(uris: &[String]) -> Vec<u8> {
    let mut out = String::from("copy");
    for uri in uris {
        out.push('\n');
        out.push_str(uri);
    }
    out.into_bytes()
}

/// Which served target a paste requested, so the shared renderer picks the right
/// payload format.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Target {
    /// `text/uri-list` — CRLF-terminated `file://` lines.
    UriList,
    /// `x-special/gnome-copied-files` / `x-special/mate-copied-files` — a leading
    /// `copy` line then LF-separated `file://` lines.
    GnomeCopiedFiles,
}

impl Target {
    /// Map a requested Wayland MIME type string to a served [`Target`], or `None`
    /// for a type we never advertised. (X11 compares interned atoms directly and
    /// does not go through here.)
    fn from_mime(mime: &str) -> Option<Self> {
        match mime {
            "text/uri-list" => Some(Target::UriList),
            "x-special/gnome-copied-files" | "x-special/mate-copied-files" => {
                Some(Target::GnomeCopiedFiles)
            }
            _ => None,
        }
    }
}

/// The shared fetch context: how to reach the remote for the promised files.
/// Cloned into each owner (X11 and/or Wayland) so both can serve independently.
#[derive(Clone)]
struct FetchContext {
    /// Clone of the graphical manager (Arc-backed) used to reach the session's
    /// backend for on-demand byte fetches.
    manager: GraphicalSessionManager,
    /// The session whose remote clipboard these files belong to.
    session_id: String,
    /// Advertised indices to fetch, in paste order.
    indices: Vec<u32>,
}

impl FetchContext {
    /// Delayed render: fetch each promised file's bytes now, one at a time (bounded
    /// memory), staging them to sanitized temp files, and format the collected
    /// `file://` URIs for the requested `target`. Returns `None` when nothing could
    /// be fetched, so the caller refuses the conversion cleanly.
    ///
    /// Runs on the owner's serving thread and drives the tokio runtime's worker
    /// threads for the fetch (never blocking on the owner's own event socket in a
    /// way that could deadlock), mirroring the macOS `provideDataForType:` render.
    fn render(&self, target: Target) -> Option<Vec<u8>> {
        let mut uris: Vec<String> = Vec::new();
        for &index in &self.indices {
            match tauri::async_runtime::block_on(
                self.manager.fetch_remote_clipboard_file(&self.session_id, index),
            ) {
                Ok(path) => uris.push(path_to_file_uri(&path)),
                Err(e) => {
                    tracing::warn!("failed to fetch remote clipboard file {index} for paste: {e}")
                }
            }
        }
        if uris.is_empty() {
            return None;
        }
        Some(match target {
            Target::UriList => build_uri_list(&uris),
            Target::GnomeCopiedFiles => build_gnome_copied_files(&uris),
        })
    }
}

/// Whether the current desktop session is Wayland — i.e. `WAYLAND_DISPLAY` names a
/// non-empty socket. Native-only Wayland clients read the clipboard over
/// `wlr-data-control`, which the [`wayland`] path serves; when this is false the
/// session is pure X11 and only the [`x11`] owner is needed.
///
/// Pure over the environment so path selection is unit-testable.
fn session_is_wayland() -> bool {
    env_is_set("WAYLAND_DISPLAY")
}

/// Whether an X server is reachable — i.e. `DISPLAY` names a non-empty target.
/// Under a Wayland session this is XWayland; under a pure X11 session it is the X
/// server itself. When false there is no X11 selection to own.
fn x_server_available() -> bool {
    env_is_set("DISPLAY")
}

/// `true` when environment variable `name` is set to a non-empty value.
fn env_is_set(name: &str) -> bool {
    std::env::var_os(name).is_some_and(|v| !v.is_empty())
}

/// Bind the remote-copied clipboard `files` onto the host clipboard with delayed
/// rendering, so they can be pasted into any local app. The bytes are fetched only
/// on the actual paste, via `manager` and `session_id`.
///
/// Installs the native Wayland source (on a Wayland session) and/or the X11 owner
/// (whenever an X server is reachable); see the [module docs](self) for the
/// arbitration. Succeeds if at least one system was bound.
///
/// Signature mirrors [`crate::macos_clipboard::bind_remote_clipboard_files`] so
/// the `remote_desktop_bind_clipboard_files` command calls either identically; the
/// `AppHandle` is unused here (the owner windows/sources are our own, not Tauri's).
pub fn bind_remote_clipboard_files(
    _app_handle: &AppHandle,
    manager: GraphicalSessionManager,
    session_id: String,
    files: Vec<RemoteClipboardFile>,
) -> anyhow::Result<()> {
    let indices = pasteable_indices(&files);
    if indices.is_empty() {
        return Ok(());
    }
    let ctx = FetchContext {
        manager,
        session_id,
        indices,
    };

    let mut wayland_bound = false;
    // Prefer the native Wayland clipboard first: on a Wayland session it is what
    // native-only clients read. A missing `wlr-data-control` (older compositors)
    // is not fatal — we fall through to the X11/XWayland owner below.
    if session_is_wayland() {
        match wayland::bind(ctx.clone()) {
            Ok(()) => wayland_bound = true,
            Err(e) => tracing::warn!(
                "native Wayland clipboard bind failed, relying on X11/XWayland: {e}"
            ),
        }
    }

    // The X11 `CLIPBOARD` owner covers pure-X11 sessions and, under Wayland, every
    // XWayland-bridged app (#1815). Attempt it whenever an X server is reachable.
    if x_server_available() {
        match x11::bind(ctx) {
            Ok(()) => return Ok(()),
            Err(e) => {
                if wayland_bound {
                    tracing::warn!("X11 clipboard bind failed, native Wayland source is active: {e}");
                } else {
                    return Err(e);
                }
            }
        }
    }

    if wayland_bound {
        Ok(())
    } else {
        Err(anyhow::anyhow!(
            "no Wayland or X11 clipboard binding available (neither WAYLAND_DISPLAY nor a \
             reachable X server)"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn file(index: u32, is_dir: bool) -> RemoteClipboardFile {
        RemoteClipboardFile {
            name: format!("f{index}"),
            relative_path: None,
            size: Some(1),
            is_dir,
            index,
        }
    }

    #[test]
    fn pasteable_indices_keep_files_in_order_and_drop_dirs() {
        let files = vec![file(0, false), file(1, true), file(2, false)];
        assert_eq!(pasteable_indices(&files), vec![0, 2]);
    }

    #[test]
    fn pasteable_indices_empty_when_only_dirs_or_none() {
        assert!(pasteable_indices(&[]).is_empty());
        assert!(pasteable_indices(&[file(0, true), file(1, true)]).is_empty());
    }

    #[test]
    fn file_uri_encodes_absolute_path_with_empty_authority() {
        assert_eq!(
            path_to_file_uri(&PathBuf::from("/tmp/remote/a.txt")),
            "file:///tmp/remote/a.txt"
        );
    }

    #[test]
    fn file_uri_percent_encodes_space_and_reserved_chars() {
        // Space → %20, `#` → %23, `?` → %3F; `/`, `.`, `-`, `_` stay literal.
        assert_eq!(
            path_to_file_uri(&PathBuf::from("/tmp/a b#c?_d-e.txt")),
            "file:///tmp/a%20b%23c%3F_d-e.txt"
        );
    }

    #[test]
    fn file_uri_percent_encodes_non_ascii_as_utf8_bytes() {
        // `ï` is U+00EF = UTF-8 C3 AF; `é` is U+00E9 = C3 A9.
        assert_eq!(
            path_to_file_uri(&PathBuf::from("/tmp/naïve/café.txt")),
            "file:///tmp/na%C3%AFve/caf%C3%A9.txt"
        );
    }

    #[test]
    fn uri_list_is_crlf_terminated_per_rfc_2483() {
        let uris = vec![
            "file:///tmp/a.txt".to_string(),
            "file:///tmp/b.png".to_string(),
        ];
        assert_eq!(
            build_uri_list(&uris),
            b"file:///tmp/a.txt\r\nfile:///tmp/b.png\r\n".to_vec()
        );
    }

    #[test]
    fn uri_list_of_single_file_still_terminates() {
        assert_eq!(
            build_uri_list(&["file:///tmp/only.bin".to_string()]),
            b"file:///tmp/only.bin\r\n".to_vec()
        );
    }

    #[test]
    fn gnome_copied_files_starts_with_copy_and_lf_separates() {
        let uris = vec![
            "file:///tmp/a.txt".to_string(),
            "file:///tmp/b.png".to_string(),
        ];
        assert_eq!(
            build_gnome_copied_files(&uris),
            b"copy\nfile:///tmp/a.txt\nfile:///tmp/b.png".to_vec()
        );
    }

    #[test]
    fn gnome_copied_files_of_single_file_has_no_trailing_newline() {
        assert_eq!(
            build_gnome_copied_files(&["file:///tmp/only.bin".to_string()]),
            b"copy\nfile:///tmp/only.bin".to_vec()
        );
    }

    #[test]
    fn target_maps_advertised_wayland_mimes_and_rejects_others() {
        assert_eq!(Target::from_mime("text/uri-list"), Some(Target::UriList));
        assert_eq!(
            Target::from_mime("x-special/gnome-copied-files"),
            Some(Target::GnomeCopiedFiles)
        );
        assert_eq!(
            Target::from_mime("x-special/mate-copied-files"),
            Some(Target::GnomeCopiedFiles)
        );
        assert_eq!(Target::from_mime("text/plain"), None);
        assert_eq!(Target::from_mime(""), None);
    }

    #[test]
    fn env_is_set_requires_a_non_empty_value() {
        let key = "TERMIHUB_TEST_CLIPBOARD_ENV";
        std::env::remove_var(key);
        assert!(!env_is_set(key));
        std::env::set_var(key, "");
        assert!(!env_is_set(key));
        std::env::set_var(key, "wayland-0");
        assert!(env_is_set(key));
        std::env::remove_var(key);
    }
}
