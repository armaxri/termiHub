//! Native Linux clipboard binding for pasting remote-copied RDP clipboard files
//! into local apps with **delayed rendering** (#1815).
//!
//! The Linux sibling of [`crate::macos_clipboard`] (`NSPasteboard`, #1804) and
//! `crate::windows_clipboard` (`CF_HDROP`, #1814): the RDP sidecar surfaces the
//! list of files the remote copied (`GraphicalBackend::remote_clipboard_files`)
//! and streams a file's bytes on demand (`fetch_remote_clipboard_file`); this
//! module binds that transport to the host's **X11 `CLIPBOARD` selection**,
//! serving the file list as `text/uri-list` (plus the
//! `x-special/gnome-copied-files` / `x-special/mate-copied-files` variants file
//! managers expect) so the copied files can be pasted into Files/Nautilus, Nemo,
//! Caja, Dolphin, or any local app.
//!
//! ## Delayed rendering, the X11 way
//!
//! X11 has no "put bytes on the clipboard" primitive: a client instead **owns a
//! selection** and answers `SelectionRequest` conversion events when another
//! client pastes. That ownership model *is* delayed rendering — we advertise the
//! target types on the `CLIPBOARD` selection and produce the data only when a
//! paste converts the selection. When the target requests one of our file
//! targets, and only then, we fetch each promised file's bytes from the remote
//! (streamed into a sanitized, bounded temp file by the sidecar) and answer with a
//! `text/uri-list` (or gnome/mate) payload of `file://` URIs pointing at the
//! staged paths. No bytes move on copy; RAM stays bounded to whatever a single
//! fetch stages, since files are fetched one at a time inside the request.
//!
//! The reader side (`rdp-sidecar/src/host_clipboard.rs`) uses the `x11-clipboard`
//! crate's `store`, but that stores **fixed bytes** and answers every conversion
//! with them — it has no per-request callback, so it cannot fetch on paste. True
//! delayed rendering therefore needs a selection owner we drive ourselves, which
//! is why this owns the selection directly via **`x11rb`** (the same pure-Rust,
//! libxcb-free X11 stack `x11-clipboard` is built on — `RustConnection`, no
//! system-library build dependency).
//!
//! ## The owner thread
//!
//! A selection owner must stay alive to answer conversion requests. This module
//! owns a dedicated **X11 connection + hidden window** on its own thread running a
//! blocking event loop (`wait_for_event`), created lazily on the first bind and
//! kept for the app's lifetime — the analog of the macOS pasteboard owner object
//! and the Windows message-only owner window. A [`bind_remote_clipboard_files`]
//! call stores the fetch context and acquires `CLIPBOARD` ownership; the owner
//! thread then serves conversions from that context. A new bind replaces (and
//! drops) the previous context; a `SelectionClear` (another app took the
//! clipboard) drops it too, so a stale promise can never be served.
//!
//! The per-file fetch inside a conversion drives the tokio runtime's worker
//! threads (never the owner thread), so blocking the owner thread for the duration
//! of a paste keeps memory bounded and cannot deadlock — the same reasoning as the
//! macOS `provideDataForType:` callback and the Windows `WM_RENDERFORMAT` render.
//!
//! ## Wayland
//!
//! Native-Wayland clients read the clipboard over `wlr-data-control`, which
//! `wl-clipboard-rs` serves only from **fixed bytes** (no per-request callback),
//! so a *delayed* Wayland data source is not cleanly achievable with the in-tree
//! crate — it is scoped to a follow-up (#1815 → Wayland). In practice a Wayland
//! session runs XWayland, which bridges this very X11 `CLIPBOARD` selection to
//! Wayland clients, so most desktop apps under Wayland can still paste the files;
//! the follow-up covers the native-only apps that bypass the bridge.
//!
//! Everything here is `#[cfg(target_os = "linux")]`-gated at the module
//! declaration in `lib.rs`. On a platform with no binding `clipboard_delayed_render`
//! stays off and the eager shared-folder download (#1765) remains the behaviour.

use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;

use percent_encoding::{percent_encode, AsciiSet, NON_ALPHANUMERIC};
use tauri::AppHandle;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    Atom, AtomEnum, ConnectionExt as _, CreateWindowAux, EventMask, PropMode, SelectionNotifyEvent,
    SelectionRequestEvent, Window, WindowClass, SELECTION_NOTIFY_EVENT,
};
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;
use x11rb::{CURRENT_TIME, NONE};

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
/// Pure and X11-free so the selection logic is unit-testable without a display.
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

/// How to fetch each promised file when a paste converts the selection.
struct BindContext {
    /// Clone of the graphical manager (Arc-backed) used to reach the session's
    /// backend for on-demand byte fetches.
    manager: GraphicalSessionManager,
    /// The session whose remote clipboard these files belong to.
    session_id: String,
    /// Advertised indices to fetch, in paste order.
    indices: Vec<u32>,
}

/// The interned atoms the owner needs, resolved once at init. `Copy` (every field
/// is an `Atom`, a `u32`) so the owner thread gets its own value copy.
#[derive(Clone, Copy)]
struct Atoms {
    clipboard: Atom,
    targets: Atom,
    uri_list: Atom,
    gnome: Atom,
    mate: Atom,
}

/// The long-lived X11 selection owner: connection, hidden owner window, atoms, and
/// the current fetch context. Shared (via `Arc`) between the caller thread (which
/// acquires ownership and swaps the context) and the owner thread (which serves
/// conversions).
struct Owner {
    conn: Arc<RustConnection>,
    window: Window,
    atoms: Atoms,
    /// The context for the most recent bind; `None` after a `SelectionClear` or
    /// before the first bind. A short lock is taken to read/replace it — never held
    /// across a fetch.
    current: Arc<Mutex<Option<BindContext>>>,
}

/// The process-wide selection owner, created lazily on the first successful bind.
/// Held behind a `Mutex<Option<…>>` (not a bare `OnceLock`) so a bind attempted
/// before an X server is reachable can retry on a later bind rather than caching
/// the failure forever.
static OWNER: OnceLock<Mutex<Option<Owner>>> = OnceLock::new();

fn owner_slot() -> &'static Mutex<Option<Owner>> {
    OWNER.get_or_init(|| Mutex::new(None))
}

/// Bind the remote-copied clipboard `files` onto the X11 `CLIPBOARD` selection
/// with delayed rendering (#1815), so they can be pasted into any local app. The
/// bytes are fetched only on the actual paste, via `manager` and `session_id`.
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

    let mut slot = owner_slot()
        .lock()
        .map_err(|_| anyhow::anyhow!("clipboard owner lock poisoned"))?;
    if slot.is_none() {
        *slot = Some(Owner::start()?);
    }
    let owner = slot.as_ref().expect("owner just initialised");

    // Publish the fetch context, then take ownership of CLIPBOARD so the server
    // routes conversion requests to our window. The order matters: a request could
    // arrive the instant we own the selection, and it must find the context.
    {
        let mut current = owner
            .current
            .lock()
            .map_err(|_| anyhow::anyhow!("clipboard context lock poisoned"))?;
        *current = Some(BindContext {
            manager,
            session_id,
            indices,
        });
    }
    owner
        .conn
        .set_selection_owner(owner.window, owner.atoms.clipboard, CURRENT_TIME)?;
    owner.conn.flush()?;
    Ok(())
}

impl Owner {
    /// Connect to the X server, create the hidden owner window, intern the atoms,
    /// and spawn the event-loop thread. Fails (rather than panicking) when no X
    /// server is reachable, so the caller can surface it and the round degrades to
    /// no host paste.
    fn start() -> anyhow::Result<Self> {
        let (conn, screen_num) = RustConnection::connect(None)
            .map_err(|e| anyhow::anyhow!("failed to connect to the X server: {e}"))?;
        let conn = Arc::new(conn);
        let screen = &conn.setup().roots[screen_num];
        let root = screen.root;

        // A 1x1, never-mapped window is enough to own a selection and receive the
        // SelectionRequest/SelectionClear events the server routes to the owner.
        let window = conn.generate_id()?;
        conn.create_window(
            screen.root_depth,
            window,
            root,
            0,
            0,
            1,
            1,
            0,
            WindowClass::INPUT_OUTPUT,
            screen.root_visual,
            &CreateWindowAux::new().event_mask(EventMask::PROPERTY_CHANGE),
        )?;

        let atoms = Atoms {
            clipboard: intern(&conn, b"CLIPBOARD")?,
            targets: intern(&conn, b"TARGETS")?,
            uri_list: intern(&conn, b"text/uri-list")?,
            gnome: intern(&conn, b"x-special/gnome-copied-files")?,
            mate: intern(&conn, b"x-special/mate-copied-files")?,
        };
        conn.flush()?;

        let current: Arc<Mutex<Option<BindContext>>> = Arc::new(Mutex::new(None));

        // The owner thread outlives this function and holds its own Arc clones, so
        // the selection keeps being served for the app's lifetime.
        let thread_conn = Arc::clone(&conn);
        let thread_current = Arc::clone(&current);
        let thread_atoms = atoms;
        thread::Builder::new()
            .name("termihub-clipboard-owner".to_string())
            .spawn(move || event_loop(thread_conn, window, thread_atoms, thread_current))
            .map_err(|e| anyhow::anyhow!("failed to spawn clipboard owner thread: {e}"))?;

        Ok(Self {
            conn,
            window,
            atoms,
            current,
        })
    }
}

/// Intern a single atom, creating it if absent.
fn intern(conn: &RustConnection, name: &[u8]) -> anyhow::Result<Atom> {
    Ok(conn.intern_atom(false, name)?.reply()?.atom)
}

/// The selection owner's blocking event loop: serve `SelectionRequest`
/// conversions from the current fetch context and drop the context on
/// `SelectionClear`. Runs for the app's lifetime; exits only if the X connection
/// drops.
fn event_loop(
    conn: Arc<RustConnection>,
    window: Window,
    atoms: Atoms,
    current: Arc<Mutex<Option<BindContext>>>,
) {
    loop {
        let event = match conn.wait_for_event() {
            Ok(event) => event,
            Err(e) => {
                tracing::warn!("clipboard owner X11 connection dropped: {e}");
                return;
            }
        };
        match event {
            Event::SelectionRequest(req) => {
                if let Err(e) = serve_request(&conn, window, &atoms, &current, &req) {
                    tracing::warn!("failed to serve clipboard conversion request: {e}");
                }
            }
            Event::SelectionClear(_) => {
                // Another app took CLIPBOARD ownership: drop the staged context so a
                // stale promise can never be served.
                if let Ok(mut slot) = current.lock() {
                    *slot = None;
                }
            }
            _ => {}
        }
    }
}

/// Answer one `SelectionRequest`: fill the requestor's property with the converted
/// data (or refuse), then notify. Fetches the remote files only when the target is
/// one of our file targets — this is the delayed render.
fn serve_request(
    conn: &RustConnection,
    window: Window,
    atoms: &Atoms,
    current: &Mutex<Option<BindContext>>,
    req: &SelectionRequestEvent,
) -> anyhow::Result<()> {
    // Ignore requests aimed at a stale owner window (we are the current owner only
    // for `window`).
    if req.owner != window {
        return refuse(conn, req);
    }

    // Per ICCCM, a `None` property means an obsolete requestor; use the target atom
    // as the property name in that case.
    let property = if req.property == NONE {
        req.target
    } else {
        req.property
    };

    if req.target == atoms.targets {
        // Advertise what we can convert to.
        let targets = [atoms.targets, atoms.uri_list, atoms.gnome, atoms.mate];
        conn.change_property32(
            PropMode::REPLACE,
            req.requestor,
            property,
            AtomEnum::ATOM,
            &targets,
        )?;
        return send_notify(conn, req, property);
    }

    let is_uri_list = req.target == atoms.uri_list;
    let is_gnome = req.target == atoms.gnome || req.target == atoms.mate;
    if !is_uri_list && !is_gnome {
        // A target we never advertised (e.g. a text/plain probe) — refuse cleanly.
        return refuse(conn, req);
    }

    // Snapshot the context out of the lock, then fetch without holding it.
    let Some((manager, session_id, indices)) = current.lock().ok().and_then(|slot| {
        slot.as_ref().map(|ctx| {
            (
                ctx.manager.clone(),
                ctx.session_id.clone(),
                ctx.indices.clone(),
            )
        })
    }) else {
        return refuse(conn, req);
    };

    // Delayed render: fetch each promised file's bytes now, one at a time (bounded
    // memory), staging them to sanitized temp files and collecting `file://` URIs.
    let mut uris: Vec<String> = Vec::new();
    for index in indices {
        match tauri::async_runtime::block_on(
            manager.fetch_remote_clipboard_file(&session_id, index),
        ) {
            Ok(path) => uris.push(path_to_file_uri(&path)),
            Err(e) => {
                tracing::warn!("failed to fetch remote clipboard file {index} for paste: {e}")
            }
        }
    }
    if uris.is_empty() {
        return refuse(conn, req);
    }

    let data = if is_gnome {
        build_gnome_copied_files(&uris)
    } else {
        build_uri_list(&uris)
    };
    conn.change_property8(
        PropMode::REPLACE,
        req.requestor,
        property,
        req.target,
        &data,
    )?;
    send_notify(conn, req, property)
}

/// Send a refusing `SelectionNotify` (property = `None`), the ICCCM way to decline
/// a conversion.
fn refuse(conn: &RustConnection, req: &SelectionRequestEvent) -> anyhow::Result<()> {
    send_notify(conn, req, NONE)
}

/// Send a `SelectionNotify` to the requestor: `property` names the property we
/// filled with the converted data, or `NONE` to refuse the conversion.
fn send_notify(
    conn: &RustConnection,
    req: &SelectionRequestEvent,
    property: Atom,
) -> anyhow::Result<()> {
    let event = SelectionNotifyEvent {
        response_type: SELECTION_NOTIFY_EVENT,
        sequence: 0,
        time: req.time,
        requestor: req.requestor,
        selection: req.selection,
        target: req.target,
        property,
    };
    conn.send_event(false, req.requestor, EventMask::NO_EVENT, event)?;
    conn.flush()?;
    Ok(())
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
}
