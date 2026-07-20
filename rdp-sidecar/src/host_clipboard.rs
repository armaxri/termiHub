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
//! which asks `NSPasteboard` for file URLs), the **Windows** clipboard's
//! `CF_HDROP` file list (via `clipboard-win`, #1791), and the **Linux**
//! clipboard's `text/uri-list` selection on both **X11** and **Wayland** (#1792).
//! On any platform whose reader is not wired the reader returns an empty list, so
//! the backend simply falls back to the #1778 sandboxed-shared-folder offer — the
//! feature degrades per platform rather than breaking. Keeping the platform reader
//! behind this one function means adding a platform is a single-function change.
//!
//! Each platform crate is intentionally target-gated (see the sidecar
//! `Cargo.toml`): `clipboard-files` is **macOS only** (its Linux path links `gtk`,
//! its Windows path links `clipboard-win`), `clipboard-win` is **Windows only**,
//! and the Linux readers (`x11-clipboard`, `wl-clipboard-rs`) are **Linux only**.
//! Dragging any of them into a platform whose reader is not wired would be pure
//! cost. All live in the workspace-**excluded** sidecar graph, so they add zero
//! conflict risk to the main app (#1747).
//!
//! On **Windows** the raw `CF_HDROP` bytes (a `DROPFILES` header followed by a
//! double-null-terminated path list) are parsed by [`parse_cf_hdrop`], and on
//! **Linux** the raw `text/uri-list` selection is parsed by [`parse_uri_list`],
//! rather than by a platform crate's own helper: both are pure functions over the
//! clipboard bytes, so the decode is unit-testable on any CI runner, where a live
//! OS clipboard cannot be read.
//!
//! The Linux reader deliberately avoids `gtk` (which `clipboard-files` would pull
//! in): GTK clipboard reads require the process's main thread and a running GTK
//! main loop, which a headless sidecar called from a tokio worker cannot promise.
//! `x11-clipboard` (pure Rust over `x11rb`, no `libxcb`) and `wl-clipboard-rs`
//! (with `dlopen`, no link-time `libwayland`) are window-less, thread-agnostic,
//! blocking clients that fit the sidecar and add no system-library build
//! dependency to the bundle CI. Under Wayland the reader tries the Wayland
//! clipboard first and falls back to X11, because XWayland bridges the same
//! selection and some compositors do not implement the `wlr-data-control`
//! protocol `wl-clipboard-rs` needs.

use std::path::PathBuf;

// `debug` is used by the macOS, Windows and Linux readers; on a platform with no
// reader wired the fallback stub logs nothing, so allow it to go unused there.
#[cfg_attr(
    not(any(target_os = "macos", windows, target_os = "linux")),
    allow(unused_imports)
)]
use tracing::debug;
// `warn` is only emitted by the macOS and Windows readers (the Linux path treats
// every failure as an expected "no files" case and logs at debug).
#[cfg(any(target_os = "macos", windows))]
use tracing::warn;

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

/// Reads the Linux clipboard's `text/uri-list` selection — the files the user
/// copied in their file manager — and returns their absolute paths in clipboard
/// order (#1792).
///
/// Any failure (no display, no `text/uri-list` on the clipboard, unreadable data)
/// yields an empty list: that is the "nothing to offer" signal the backend uses
/// to fall back to the sandboxed shared folder (#1778), so a broken read must
/// never tear down the session. The chosen client hands us the raw selection
/// bytes; the platform-agnostic [`parse_uri_list`] decodes them.
///
/// Under Wayland the Wayland clipboard is tried first with an X11 fallback (see
/// the module docs); otherwise only X11 is consulted.
#[cfg(target_os = "linux")]
pub fn read_host_clipboard_files() -> Vec<PathBuf> {
    let raw = if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        read_wayland_uri_list().or_else(read_x11_uri_list)
    } else {
        read_x11_uri_list()
    };

    match raw {
        Some(text) => {
            let paths = parse_uri_list(&text);
            debug!(
                count = paths.len(),
                "read host clipboard file list (text/uri-list)"
            );
            paths
        }
        None => Vec::new(),
    }
}

/// Reads the `text/uri-list` target of the X11 `CLIPBOARD` selection, returning
/// the raw selection text or `None` when there is no X server, no such target, or
/// the read fails. Uses `x11-clipboard` (pure Rust over `x11rb`), which owns a
/// hidden window and a background event thread, so it is safe to call from any
/// thread without a GTK main loop.
#[cfg(target_os = "linux")]
fn read_x11_uri_list() -> Option<String> {
    use std::time::Duration;

    let clipboard = match x11_clipboard::Clipboard::new() {
        Ok(clipboard) => clipboard,
        Err(error) => {
            // No X server reachable (`$DISPLAY` unset / headless) — expected off a
            // desktop, not an error worth escalating.
            debug!(%error, "no X11 clipboard available; offering no files");
            return None;
        }
    };

    let target = clipboard.getter.get_atom("text/uri-list").ok()?;
    let bytes = clipboard
        .load(
            clipboard.getter.atoms.clipboard,
            target,
            clipboard.getter.atoms.property,
            Duration::from_secs(3),
        )
        .ok()?;

    // The clipboard holds no file list (it is text / an image / empty) — the
    // expected common case.
    if bytes.is_empty() {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// Reads the `text/uri-list` MIME type of the regular Wayland clipboard, returning
/// the raw selection text or `None` when there is no Wayland display, the
/// compositor offers no such type, or the read fails. `wl-clipboard-rs` is a
/// window-less blocking client (no GTK main loop required).
#[cfg(target_os = "linux")]
fn read_wayland_uri_list() -> Option<String> {
    use std::io::Read;
    use wl_clipboard_rs::paste::{get_contents, ClipboardType, MimeType, Seat};

    match get_contents(
        ClipboardType::Regular,
        Seat::Unspecified,
        MimeType::Specific("text/uri-list"),
    ) {
        Ok((mut pipe, _mime)) => {
            let mut bytes = Vec::new();
            if pipe.read_to_end(&mut bytes).is_err() || bytes.is_empty() {
                return None;
            }
            Some(String::from_utf8_lossy(&bytes).into_owned())
        }
        // An empty clipboard, no matching MIME type, or no seat all mean "nothing
        // to offer" — the expected common case, not an error. A missing
        // `wlr-data-control` protocol also lands here, and the caller falls back
        // to X11.
        Err(error) => {
            debug!(%error, "no text/uri-list on the Wayland clipboard; offering none");
            None
        }
    }
}

/// Host-clipboard file reading is not wired for this platform, so it offers no
/// files and the backend falls back to the sandboxed shared folder (#1778).
#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
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

/// Decodes a Linux `text/uri-list` clipboard payload into absolute paths, in
/// clipboard order (#1792).
///
/// Per [RFC 2483](https://www.rfc-editor.org/rfc/rfc2483#section-5) a
/// `text/uri-list` is CRLF-separated lines where a `#` line is a comment; file
/// managers put one `file:` URI per line. Each URI's path component is
/// percent-decoded. Non-`file:` schemes and `file://<remote-host>/…` URIs (a path
/// on another machine we cannot serve locally) are skipped rather than mis-served;
/// an empty host or `localhost` denotes this machine and is kept.
///
/// This is a pure function over the clipboard string on purpose: it keeps the
/// `text/uri-list` decode unit-testable on any platform (a real X11/Wayland
/// clipboard cannot be read in headless CI), which is why the decode is done here
/// rather than via a platform crate's own URI helper.
#[cfg(any(target_os = "linux", test))]
fn parse_uri_list(data: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for line in data.lines() {
        // `str::lines` splits on `\n` and strips a trailing `\r`, so CRLF and LF
        // payloads both arrive CR-free here; trim any other stray whitespace.
        let line = line.trim();
        // Blank lines and `#` comment lines carry no URI.
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(path) = file_uri_to_path(line) {
            paths.push(path);
        }
    }
    paths
}

/// Converts a single `file:` URI to a local path, or `None` when it is not a local
/// `file:` URI this host can serve. Handles `file://<host>/path`, `file:///path`,
/// and the authority-less `file:/path`; percent-decodes the path component.
#[cfg(any(target_os = "linux", test))]
fn file_uri_to_path(uri: &str) -> Option<PathBuf> {
    use percent_encoding::percent_decode_str;

    let rest = uri.strip_prefix("file:")?;
    let encoded_path = if let Some(after_slashes) = rest.strip_prefix("//") {
        // `//<host>/path`: the authority runs up to the next `/`. An empty host or
        // `localhost` means this machine; a real remote host is not a local path.
        let slash = after_slashes.find('/')?;
        let host = &after_slashes[..slash];
        if !host.is_empty() && !host.eq_ignore_ascii_case("localhost") {
            return None;
        }
        &after_slashes[slash..]
    } else {
        // `file:/path`: no authority component, `rest` is already the path.
        rest
    };

    let decoded = percent_decode_str(encoded_path).decode_utf8_lossy();
    if decoded.is_empty() {
        return None;
    }
    Some(PathBuf::from(decoded.into_owned()))
}

#[cfg(test)]
mod tests {
    use super::{parse_cf_hdrop, parse_uri_list};
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

    #[test]
    fn parses_crlf_uri_list_in_order() {
        let data = "file:///home/me/a.txt\r\nfile:///tmp/b.png\r\n";
        assert_eq!(
            parse_uri_list(data),
            vec![PathBuf::from("/home/me/a.txt"), PathBuf::from("/tmp/b.png"),]
        );
    }

    #[test]
    fn accepts_lf_only_line_endings() {
        // Some producers emit bare LF rather than the RFC 2483 CRLF.
        let data = "file:///a\nfile:///b";
        assert_eq!(
            parse_uri_list(data),
            vec![PathBuf::from("/a"), PathBuf::from("/b")]
        );
    }

    #[test]
    fn percent_decodes_paths() {
        // `%20` space and a UTF-8 multi-byte sequence (`é` = %C3%A9).
        let data = "file:///home/me/b%20c.txt\r\nfile:///home/Zo%C3%AB/na%C3%AFve.txt\r\n";
        assert_eq!(
            parse_uri_list(data),
            vec![
                PathBuf::from("/home/me/b c.txt"),
                PathBuf::from("/home/Zoë/naïve.txt"),
            ]
        );
    }

    #[test]
    fn skips_comment_and_blank_lines() {
        let data = "# a comment\r\n\r\nfile:///real\r\n   \r\n";
        assert_eq!(parse_uri_list(data), vec![PathBuf::from("/real")]);
    }

    #[test]
    fn skips_non_file_schemes() {
        let data = "https://example.com/x\r\nfile:///keep\r\nmailto:me@x\r\n";
        assert_eq!(parse_uri_list(data), vec![PathBuf::from("/keep")]);
    }

    #[test]
    fn accepts_empty_and_localhost_authority_but_skips_remote_host() {
        let data = "file:///local/a\r\nfile://localhost/local/b\r\nfile://remote.example/c\r\n";
        assert_eq!(
            parse_uri_list(data),
            vec![PathBuf::from("/local/a"), PathBuf::from("/local/b")]
        );
    }

    #[test]
    fn accepts_authority_less_file_uri() {
        // `file:/path` (no `//` authority) is a valid, if rarer, form.
        assert_eq!(
            parse_uri_list("file:/etc/hosts\r\n"),
            vec![PathBuf::from("/etc/hosts")]
        );
    }

    #[test]
    fn empty_or_schemeless_input_yields_no_paths() {
        assert!(parse_uri_list("").is_empty());
        assert!(parse_uri_list("\r\n\r\n").is_empty());
        assert!(parse_uri_list("/not/a/uri\r\n").is_empty());
        // `file://host` with no path component names nothing servable.
        assert!(parse_uri_list("file://host\r\n").is_empty());
    }
}
