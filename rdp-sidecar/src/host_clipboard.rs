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
//! This module reads the **macOS** pasteboard (via the `clipboard-files` crate,
//! which asks `NSPasteboard` for file URLs) and the **Windows** clipboard's
//! `CF_HDROP` file list (via `clipboard-win`, #1791). Linux (`text/uri-list`)
//! reading is a sequenced follow-up: there the reader returns an empty list, so
//! the backend simply falls back to the #1778 sandboxed-shared-folder offer — the
//! feature degrades per platform rather than breaking. Keeping the platform reader
//! behind this one function means adding a platform is a single-function change.
//!
//! Each platform crate is intentionally target-gated (see the sidecar
//! `Cargo.toml`): `clipboard-files` is **macOS only** (its Linux path links `gtk`,
//! its Windows path links `clipboard-win`), and `clipboard-win` is **Windows
//! only**. Dragging either into a platform whose reader is not wired would be pure
//! cost. Both live in the workspace-**excluded** sidecar graph, so they add zero
//! conflict risk to the main app (#1747).
//!
//! On Windows the raw `CF_HDROP` bytes (a `DROPFILES` header followed by a
//! double-null-terminated path list) are parsed by [`parse_cf_hdrop`] rather than
//! by `clipboard-win`'s `DragQueryFileW`-based helper: our own parser is a pure
//! function over a byte slice, so the decode is unit-testable on non-Windows CI,
//! where a live Win32 clipboard cannot be read.

use std::path::PathBuf;

#[cfg_attr(not(any(target_os = "macos", windows)), allow(unused_imports))]
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

/// Reads the Windows clipboard's `CF_HDROP` file list — the files the user copied
/// in Explorer — and returns their absolute paths in clipboard order (#1791).
///
/// Any failure (clipboard busy, no `CF_HDROP`, unreadable data) yields an empty
/// list: that is the "nothing to offer" signal the backend uses to fall back to
/// the sandboxed shared folder (#1778), so a broken read must never tear down the
/// session. `clipboard-win` gives us the raw `CF_HDROP` bytes; the platform-
/// agnostic [`parse_cf_hdrop`] decodes them.
#[cfg(windows)]
pub fn read_host_clipboard_files() -> Vec<PathBuf> {
    use clipboard_win::{formats, raw, Clipboard};

    // Open with retries: another process may briefly hold the clipboard. The
    // guard closes it on drop.
    let _clipboard = match Clipboard::new_attempts(10) {
        Ok(clipboard) => clipboard,
        Err(error) => {
            warn!(%error, "failed to open host clipboard; offering no files");
            return Vec::new();
        }
    };

    // No file list on the clipboard (it holds text / an image / nothing) — the
    // expected common case, not an error.
    if !raw::is_format_avail(formats::CF_HDROP) {
        return Vec::new();
    }

    let mut bytes = Vec::new();
    if let Err(error) = raw::get_vec(formats::CF_HDROP, &mut bytes) {
        warn!(%error, "failed to read CF_HDROP from host clipboard; offering none");
        return Vec::new();
    }

    let paths = parse_cf_hdrop(&bytes);
    debug!(
        count = paths.len(),
        "read host clipboard file list (CF_HDROP)"
    );
    paths
}

/// The Linux (`text/uri-list`) reader is a sequenced follow-up; until then Linux
/// offers no host-clipboard files and the backend falls back to the sandboxed
/// shared folder (#1778).
#[cfg(not(any(target_os = "macos", windows)))]
pub fn read_host_clipboard_files() -> Vec<PathBuf> {
    Vec::new()
}

/// Decodes the raw bytes of a Windows `CF_HDROP` clipboard object into absolute
/// paths, in clipboard order (#1791).
///
/// The bytes are a [`DROPFILES`](https://learn.microsoft.com/windows/win32/api/shlobj_core/ns-shlobj_core-dropfiles)
/// header (20 bytes: `pFiles` offset, `POINT`, `fNC`, `fWide`) followed at offset
/// `pFiles` by a **double-null-terminated** list of paths — UTF-16LE when `fWide`
/// is set, otherwise ANSI bytes. A malformed or truncated buffer yields an empty
/// list rather than a panic.
///
/// This is a pure function over a byte slice on purpose: it keeps the `CF_HDROP`
/// decode unit-testable on any platform (a real Win32 clipboard cannot be read in
/// headless CI), which is why the decode is done here rather than via
/// `clipboard-win`'s `DragQueryFileW` helper.
#[cfg(any(windows, test))]
fn parse_cf_hdrop(bytes: &[u8]) -> Vec<PathBuf> {
    // DROPFILES: pFiles (u32) + POINT { x, y } (2x u32) + fNC (u32) + fWide (u32).
    const DROPFILES_HEADER_LEN: usize = 20;
    if bytes.len() < DROPFILES_HEADER_LEN {
        return Vec::new();
    }

    let files_offset = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    let wide = u32::from_le_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]) != 0;

    // The path list must start at or after the header and stay within the buffer.
    if files_offset < DROPFILES_HEADER_LEN || files_offset > bytes.len() {
        return Vec::new();
    }
    let list = &bytes[files_offset..];

    let mut paths = Vec::new();
    if wide {
        let units: Vec<u16> = list
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        for segment in units.split(|&unit| unit == 0) {
            // The list is double-null terminated: the first empty segment is the
            // terminator (an empty path is never a real entry).
            if segment.is_empty() {
                break;
            }
            paths.push(PathBuf::from(String::from_utf16_lossy(segment)));
        }
    } else {
        for segment in list.split(|&byte| byte == 0) {
            if segment.is_empty() {
                break;
            }
            paths.push(PathBuf::from(String::from_utf8_lossy(segment).into_owned()));
        }
    }
    paths
}

#[cfg(test)]
mod tests {
    use super::parse_cf_hdrop;
    use std::path::PathBuf;

    /// Builds a synthetic `CF_HDROP` byte buffer from UTF-16LE (`wide = true`)
    /// paths, matching the layout Explorer places on the clipboard.
    fn wide_hdrop(paths: &[&str]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&20u32.to_le_bytes()); // pFiles: list starts after header
        bytes.extend_from_slice(&[0u8; 8]); // POINT { x, y }
        bytes.extend_from_slice(&0u32.to_le_bytes()); // fNC
        bytes.extend_from_slice(&1u32.to_le_bytes()); // fWide = true
        for path in paths {
            for unit in path.encode_utf16() {
                bytes.extend_from_slice(&unit.to_le_bytes());
            }
            bytes.extend_from_slice(&0u16.to_le_bytes()); // NUL after each path
        }
        bytes.extend_from_slice(&0u16.to_le_bytes()); // final NUL terminates the list
        bytes
    }

    /// Builds a synthetic ANSI (`wide = false`) `CF_HDROP` buffer.
    fn ansi_hdrop(paths: &[&str]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&20u32.to_le_bytes());
        bytes.extend_from_slice(&[0u8; 8]);
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes()); // fWide = false
        for path in paths {
            bytes.extend_from_slice(path.as_bytes());
            bytes.push(0);
        }
        bytes.push(0);
        bytes
    }

    #[test]
    fn parses_wide_paths_in_order() {
        let bytes = wide_hdrop(&[r"C:\Users\me\a.txt", r"D:\b.png"]);
        assert_eq!(
            parse_cf_hdrop(&bytes),
            vec![
                PathBuf::from(r"C:\Users\me\a.txt"),
                PathBuf::from(r"D:\b.png"),
            ]
        );
    }

    #[test]
    fn parses_single_wide_path() {
        let bytes = wide_hdrop(&[r"C:\only.bin"]);
        assert_eq!(parse_cf_hdrop(&bytes), vec![PathBuf::from(r"C:\only.bin")]);
    }

    #[test]
    fn parses_ansi_paths() {
        let bytes = ansi_hdrop(&[r"C:\x.txt", r"C:\y.txt"]);
        assert_eq!(
            parse_cf_hdrop(&bytes),
            vec![PathBuf::from(r"C:\x.txt"), PathBuf::from(r"C:\y.txt")]
        );
    }

    #[test]
    fn parses_non_ascii_wide_path() {
        let bytes = wide_hdrop(&[r"C:\Users\Zoë\naïve — file.txt"]);
        assert_eq!(
            parse_cf_hdrop(&bytes),
            vec![PathBuf::from(r"C:\Users\Zoë\naïve — file.txt")]
        );
    }

    #[test]
    fn honours_a_non_default_files_offset() {
        // Some producers leave padding between the header and the list; pFiles
        // points past it. Build a buffer with 4 extra padding bytes.
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&24u32.to_le_bytes()); // pFiles = 24 (header + 4 pad)
        bytes.extend_from_slice(&[0u8; 8]);
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&1u32.to_le_bytes()); // wide
        bytes.extend_from_slice(&[0u8; 4]); // padding
        for unit in r"C:\pad.txt".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        assert_eq!(parse_cf_hdrop(&bytes), vec![PathBuf::from(r"C:\pad.txt")]);
    }

    #[test]
    fn empty_list_yields_no_paths() {
        assert!(parse_cf_hdrop(&wide_hdrop(&[])).is_empty());
        assert!(parse_cf_hdrop(&ansi_hdrop(&[])).is_empty());
    }

    #[test]
    fn malformed_buffers_yield_no_paths() {
        assert!(parse_cf_hdrop(&[]).is_empty());
        assert!(parse_cf_hdrop(&[0u8; 8]).is_empty()); // shorter than the header
                                                       // pFiles points past the end of the buffer.
        let mut bad = 999u32.to_le_bytes().to_vec();
        bad.extend_from_slice(&[0u8; 16]);
        assert!(parse_cf_hdrop(&bad).is_empty());
    }
}
