//! Native Windows clipboard binding for pasting remote-copied RDP clipboard
//! files into local apps with **delayed rendering** (#1814).
//!
//! The Windows sibling of [`crate::macos_clipboard`]: the RDP sidecar surfaces
//! the list of files the remote copied (`GraphicalBackend::remote_clipboard_files`)
//! and streams a file's bytes on demand (`fetch_remote_clipboard_file`); this
//! module binds that transport to the host OS clipboard as a **`CF_HDROP`** file
//! list, so the copied files can be pasted into Explorer or any local app.
//!
//! ## Delayed rendering, the Win32 way
//!
//! When the user chooses "make the remote files pasteable" in the RemoteDesktop
//! UI, [`bind_remote_clipboard_files`] places `CF_HDROP` on the clipboard with a
//! **NULL data handle** (`SetClipboardData(CF_HDROP, NULL)`). This is Win32's
//! *delayed rendering* pattern: the clipboard owner window is asked to produce the
//! data only when another app actually reads that format — Windows sends the owner
//! `WM_RENDERFORMAT` (a single format on paste) or `WM_RENDERALLFORMATS` (all
//! formats, before the owner goes away). Only then do we fetch each file's bytes
//! from the remote (streamed into a sanitized, bounded temp file by the sidecar)
//! and build the `CF_HDROP` from the staged local paths. No bytes move on copy;
//! memory stays bounded to whatever a single fetch stages.
//!
//! `CF_HDROP` is a list of **file paths**, not bytes — exactly like macOS's
//! `NSFilenamesPboardType` — so staging each remote file to a real temp file and
//! handing Explorer that path is the correct analog; `CFSTR_FILECONTENTS` /
//! `CFSTR_FILEDESCRIPTOR` (virtual files that hand over bytes directly) are not
//! needed and are deliberately not implemented.
//!
//! ## The owner window
//!
//! Delayed rendering needs a window that owns the clipboard and stays alive to
//! answer `WM_RENDERFORMAT`. Tauri owns the app's main window and its `WndProc`,
//! which we must not subclass, so this module owns a dedicated **message-only
//! window** (`HWND_MESSAGE`) on its own thread running a `GetMessage` pump. The
//! window is created lazily on the first bind and lives for the app's lifetime.
//! Because the clipboard owner is tied to that window's thread, the actual
//! `OpenClipboard`/`SetClipboardData` offer and every render run **on the pump
//! thread**: [`bind_remote_clipboard_files`] hands the fetch context to it with a
//! synchronous `SendMessageW`, which Windows dispatches into the pump thread's
//! `WndProc`. The context is stored in a pump-thread [`thread_local`]; a new bind
//! replaces (and drops) the previous one.
//!
//! The per-file fetch inside a render drives the tokio runtime's worker threads
//! (never the pump thread), so blocking the pump thread for the duration of a
//! paste keeps memory bounded and cannot deadlock — the same reasoning as the
//! macOS `provideDataForType:` callback.
//!
//! Everything here is `#[cfg(windows)]`-gated at the module declaration in
//! `lib.rs`. macOS uses [`crate::macos_clipboard`]; Linux (X11/Wayland
//! `text/uri-list` data source) is tracked as a follow-up (#1815). On a platform
//! with no binding `clipboard_delayed_render` stays off and the eager
//! shared-folder download (#1765) remains the behaviour.

use std::cell::RefCell;
use std::ffi::c_void;
use std::ptr;
use std::sync::mpsc;
use std::sync::OnceLock;
use std::thread;

use tauri::AppHandle;
use windows_sys::Win32::Foundation::{HANDLE, HGLOBAL, HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardOwner, OpenClipboard, SetClipboardData,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW, SendMessageW,
    TranslateMessage, HWND_MESSAGE, MSG, WM_APP, WM_DESTROYCLIPBOARD, WM_RENDERALLFORMATS,
    WM_RENDERFORMAT, WNDCLASSW,
};

use crate::session::graphical_manager::GraphicalSessionManager;
use termihub_core::connection::RemoteClipboardFile;

/// The standard `CF_HDROP` clipboard format (a `DROPFILES` header + a
/// double-null-terminated path list). Defined locally as its numeric value so we
/// need not pull in the `Win32_System_Ole` feature just for the constant; the
/// sidecar's `parse_cf_hdrop` decodes the very same format.
const CF_HDROP: u32 = 15;

/// Private window message that carries a freshly-boxed [`BindContext`] pointer to
/// the pump thread so the clipboard offer runs on the owner window's thread.
const WM_APP_BIND: u32 = WM_APP + 1;

/// The advertised indices of the files worth offering to the OS clipboard — the
/// regular files, in order. Directories carry no bytes to fetch (they are
/// surfaced only so a copied tree can be recreated), so they are dropped.
///
/// Pure and Win32-free so the selection logic is unit-testable without a
/// clipboard.
fn pasteable_indices(files: &[RemoteClipboardFile]) -> Vec<u32> {
    files
        .iter()
        .filter(|f| !f.is_dir)
        .map(|f| f.index)
        .collect()
}

/// Builds the raw bytes of a `CF_HDROP` clipboard object from local file `paths`,
/// in order — the inverse of the sidecar's `parse_cf_hdrop`.
///
/// The layout is a [`DROPFILES`](https://learn.microsoft.com/windows/win32/api/shlobj_core/ns-shlobj_core-dropfiles)
/// header (20 bytes: `pFiles` offset = 20, a zero `POINT`, `fNC` = 0, `fWide` = 1)
/// followed by a **double-null-terminated** list of UTF-16LE paths. Wide (`fWide`)
/// is always used so non-ASCII paths survive.
///
/// Pure over `&str` (rather than `OsStr`) so the encoding is unit-testable on any
/// platform; the caller passes `path.to_string_lossy()`.
fn build_cf_hdrop(paths: &[String]) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&20u32.to_le_bytes()); // pFiles: list starts right after the header
    bytes.extend_from_slice(&[0u8; 8]); // POINT { x, y }
    bytes.extend_from_slice(&0u32.to_le_bytes()); // fNC
    bytes.extend_from_slice(&1u32.to_le_bytes()); // fWide = true (UTF-16LE paths)
    for path in paths {
        for unit in path.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        bytes.extend_from_slice(&0u16.to_le_bytes()); // NUL after each path
    }
    bytes.extend_from_slice(&0u16.to_le_bytes()); // final NUL terminates the list
    bytes
}

/// How to fetch each promised file when a paste renders the `CF_HDROP` format.
struct BindContext {
    /// Clone of the graphical manager (Arc-backed) used to reach the session's
    /// backend for on-demand byte fetches.
    manager: GraphicalSessionManager,
    /// The session whose remote clipboard these files belong to.
    session_id: String,
    /// Advertised indices to fetch, in paste order.
    indices: Vec<u32>,
}

thread_local! {
    /// The fetch context for the most recent bind, held on the pump thread. A new
    /// bind replaces (drops) the previous one; `WM_DESTROYCLIPBOARD` clears it when
    /// another app takes clipboard ownership. Only ever touched on the pump thread,
    /// so a plain `RefCell` is enough.
    static CURRENT: RefCell<Option<BindContext>> = const { RefCell::new(None) };
}

/// Handle of the message-only owner window, as `usize` (an `HWND` is not `Send`).
/// Initialised once on the first bind; `0` means creation failed.
static OWNER_HWND: OnceLock<usize> = OnceLock::new();

/// Bind the remote-copied clipboard `files` onto the Windows clipboard as a
/// delayed-render `CF_HDROP` (#1814), so they can be pasted into any local app.
/// The bytes are fetched only on the actual paste, via `manager` and `session_id`.
///
/// Signature mirrors [`crate::macos_clipboard::bind_remote_clipboard_files`] so
/// the `remote_desktop_bind_clipboard_files` command calls either identically; the
/// `AppHandle` is unused here (the owner window is our own, not Tauri's).
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

    let hwnd = ensure_owner_window();
    if hwnd == 0 {
        anyhow::bail!("failed to create the clipboard owner window");
    }

    // Hand the fetch context to the pump thread. `SendMessageW` is synchronous —
    // it blocks until the owner thread's `WndProc` has processed the message — so
    // ownership of the leaked box transfers cleanly with no concurrent access.
    let ctx = Box::new(BindContext {
        manager,
        session_id,
        indices,
    });
    let ptr = Box::into_raw(ctx) as usize;
    // SAFETY: `hwnd` is a live window owned by the pump thread; `WM_APP_BIND`
    // carries the boxed `BindContext` pointer, which the `WndProc` reconstructs
    // and takes ownership of.
    unsafe {
        SendMessageW(hwnd as HWND, WM_APP_BIND, ptr as WPARAM, 0);
    }
    Ok(())
}

/// Lazily create the message-only clipboard owner window on its own pump thread
/// and return its `HWND` as `usize` (`0` on failure). Idempotent: subsequent calls
/// return the same window.
fn ensure_owner_window() -> usize {
    *OWNER_HWND.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<usize>();
        let spawned = thread::Builder::new()
            .name("termihub-clipboard-owner".to_string())
            .spawn(move || owner_thread_main(tx));
        if let Err(e) = spawned {
            tracing::warn!("failed to spawn clipboard owner thread: {e}");
            return 0;
        }
        // Wait for the thread to report the created window handle (or 0).
        rx.recv().unwrap_or(0)
    })
}

/// Body of the clipboard owner thread: register the window class, create the
/// message-only window, report its handle back, then run a classic `GetMessage`
/// pump for the app's lifetime so `WM_RENDERFORMAT` (and our `WM_APP_BIND`) reach
/// the `WndProc`.
fn owner_thread_main(tx: mpsc::Sender<usize>) {
    // SAFETY: standard Win32 window-class registration + creation. The class name
    // buffer outlives both calls; `RegisterClassW` copies it.
    unsafe {
        let hinstance = GetModuleHandleW(ptr::null());
        let class_name: Vec<u16> = "TermiHubRemoteClipboardOwner\0".encode_utf16().collect();

        let wnd_class = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(wnd_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinstance,
            hIcon: ptr::null_mut(),
            hCursor: ptr::null_mut(),
            hbrBackground: ptr::null_mut(),
            lpszMenuName: ptr::null(),
            lpszClassName: class_name.as_ptr(),
        };
        // A duplicate registration is harmless; the returned atom is unused.
        RegisterClassW(&wnd_class);

        let hwnd = CreateWindowExW(
            0,
            class_name.as_ptr(),
            ptr::null(),
            0,
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            ptr::null_mut(),
            hinstance,
            ptr::null(),
        );

        let _ = tx.send(hwnd as usize);
        if hwnd.is_null() {
            tracing::warn!("failed to create the message-only clipboard owner window");
            return;
        }

        let mut msg: MSG = std::mem::zeroed();
        // `GetMessageW` returns >0 for a message, 0 for WM_QUIT, -1 on error.
        while GetMessageW(&mut msg, ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

/// Window procedure for the clipboard owner window. Runs on the pump thread.
///
/// # Safety
/// Called by Windows with valid message parameters. `WM_APP_BIND`'s `wparam` is a
/// `Box<BindContext>` pointer produced by [`bind_remote_clipboard_files`].
unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_APP_BIND => {
            // Take ownership of the boxed context and make it current (dropping any
            // previous one), then place the delayed-render offer on the clipboard.
            let ctx = if wparam != 0 {
                Some(*Box::from_raw(wparam as *mut BindContext))
            } else {
                None
            };
            CURRENT.with(|slot| *slot.borrow_mut() = ctx);
            offer_delayed_hdrop(hwnd);
            0
        }
        WM_RENDERFORMAT => {
            // A paste is reading a single format. Render only if it wants CF_HDROP;
            // the clipboard is already open for us in this message's context, so we
            // must not Open/Close it here.
            if wparam as u32 == CF_HDROP {
                render_hdrop();
            }
            0
        }
        WM_RENDERALLFORMATS => {
            // The owner is going away (e.g. app shutdown): flush the delayed format
            // if we are still the owner. Here we must open the clipboard ourselves
            // and must NOT call EmptyClipboard.
            if OpenClipboard(hwnd) != 0 {
                if GetClipboardOwner() == hwnd {
                    render_hdrop();
                }
                CloseClipboard();
            }
            0
        }
        WM_DESTROYCLIPBOARD => {
            // Another app took clipboard ownership; drop the staged context so a
            // stale promise can never be served.
            CURRENT.with(|slot| *slot.borrow_mut() = None);
            0
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// Place the `CF_HDROP` format on the clipboard with a NULL data handle — the
/// delayed-render offer. Runs on the pump thread. No bytes are fetched here.
///
/// # Safety
/// `hwnd` must be the live owner window on this (pump) thread.
unsafe fn offer_delayed_hdrop(hwnd: HWND) {
    if OpenClipboard(hwnd) == 0 {
        tracing::warn!("failed to open clipboard to offer remote files");
        return;
    }
    EmptyClipboard();
    // NULL data handle = delayed rendering: Windows will ask us to render on paste.
    SetClipboardData(CF_HDROP, ptr::null_mut());
    CloseClipboard();
}

/// Fetch every promised file's bytes on demand, build a `CF_HDROP` from the staged
/// local paths, and hand it to the clipboard via `SetClipboardData`. Runs on the
/// pump thread during a render message.
///
/// # Safety
/// Must run inside a `WM_RENDERFORMAT`/`WM_RENDERALLFORMATS` render where the
/// clipboard is open and we are (still) the owner.
unsafe fn render_hdrop() {
    // Snapshot the context so we do not hold the RefCell borrow across the fetch.
    let Some((manager, session_id, indices)) = CURRENT.with(|slot| {
        slot.borrow()
            .as_ref()
            .map(|ctx| (ctx.manager.clone(), ctx.session_id.clone(), ctx.indices.clone()))
    }) else {
        return;
    };

    let mut staged: Vec<String> = Vec::new();
    for index in indices {
        match tauri::async_runtime::block_on(
            manager.fetch_remote_clipboard_file(&session_id, index),
        ) {
            Ok(path) => staged.push(path.to_string_lossy().into_owned()),
            Err(e) => {
                tracing::warn!("failed to fetch remote clipboard file {index} for paste: {e}");
            }
        }
    }
    if staged.is_empty() {
        return;
    }

    let bytes = build_cf_hdrop(&staged);

    // Copy the CF_HDROP into a movable global; SetClipboardData takes ownership on
    // success, so we must not free it afterwards.
    let hglobal: HGLOBAL = GlobalAlloc(GMEM_MOVEABLE, bytes.len());
    if hglobal.is_null() {
        tracing::warn!("GlobalAlloc failed for CF_HDROP render");
        return;
    }
    let dst = GlobalLock(hglobal);
    if dst.is_null() {
        tracing::warn!("GlobalLock failed for CF_HDROP render");
        return;
    }
    ptr::copy_nonoverlapping(bytes.as_ptr(), dst as *mut u8, bytes.len());
    GlobalUnlock(hglobal);

    if SetClipboardData(CF_HDROP, hglobal as HANDLE).is_null() {
        // Ownership did not transfer; the global leaks rather than risking a
        // double free, but a failed render is already an error path.
        tracing::warn!("SetClipboardData(CF_HDROP) failed during render");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    /// Decodes a `CF_HDROP` buffer back into paths — a local mirror of the
    /// sidecar's `parse_cf_hdrop` — so a round-trip can assert `build_cf_hdrop`
    /// produces the exact layout Explorer expects.
    fn parse_wide_hdrop(bytes: &[u8]) -> Vec<String> {
        const HEADER: usize = 20;
        assert!(bytes.len() >= HEADER);
        let files_offset =
            u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
        let wide = u32::from_le_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]) != 0;
        assert_eq!(files_offset, HEADER);
        assert!(wide, "build_cf_hdrop always emits wide paths");
        let units: Vec<u16> = bytes[files_offset..]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        let mut paths = Vec::new();
        for segment in units.split(|&u| u == 0) {
            if segment.is_empty() {
                break;
            }
            paths.push(String::from_utf16_lossy(segment));
        }
        paths
    }

    #[test]
    fn build_cf_hdrop_round_trips_multiple_paths() {
        let paths = vec![r"C:\Users\me\a.txt".to_string(), r"D:\b.png".to_string()];
        assert_eq!(parse_wide_hdrop(&build_cf_hdrop(&paths)), paths);
    }

    #[test]
    fn build_cf_hdrop_round_trips_single_path() {
        let paths = vec![r"C:\only.bin".to_string()];
        assert_eq!(parse_wide_hdrop(&build_cf_hdrop(&paths)), paths);
    }

    #[test]
    fn build_cf_hdrop_preserves_non_ascii_paths() {
        let paths = vec![r"C:\Users\Zoë\naïve — file.txt".to_string()];
        assert_eq!(parse_wide_hdrop(&build_cf_hdrop(&paths)), paths);
    }

    #[test]
    fn build_cf_hdrop_is_double_null_terminated() {
        // A single "A" path: 20-byte header + 'A'(2) + NUL(2) + final NUL(2).
        let bytes = build_cf_hdrop(&["A".to_string()]);
        assert_eq!(bytes.len(), 20 + 2 + 2 + 2);
        assert_eq!(&bytes[bytes.len() - 4..], &[0, 0, 0, 0]);
    }
}
