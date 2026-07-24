//! The X11 `CLIPBOARD`-selection delayed-render owner (#1815).
//!
//! X11 has no "put bytes on the clipboard" primitive: a client instead **owns a
//! selection** and answers `SelectionRequest` conversion events when another
//! client pastes. That ownership model *is* delayed rendering — we advertise the
//! target types on the `CLIPBOARD` selection and produce the data only when a
//! paste converts the selection, fetching the promised files via
//! [`FetchContext::render`](super::FetchContext::render) at that moment.
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
//! A selection owner must stay alive to answer conversion requests. This owns a
//! dedicated **X11 connection + hidden window** on its own thread running a
//! blocking event loop (`wait_for_event`), created lazily on the first bind and
//! kept for the app's lifetime — the analog of the macOS pasteboard owner object
//! and the Windows message-only owner window. A [`bind`] call stores the fetch
//! context and acquires `CLIPBOARD` ownership; the owner thread then serves
//! conversions from that context. A new bind replaces (and drops) the previous
//! context; a `SelectionClear` (another app took the clipboard) drops it too, so a
//! stale promise can never be served.

use std::sync::{Arc, Mutex, OnceLock};
use std::thread;

use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    Atom, AtomEnum, ConnectionExt as _, CreateWindowAux, EventMask, PropMode, SelectionNotifyEvent,
    SelectionRequestEvent, Window, WindowClass, SELECTION_NOTIFY_EVENT,
};
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;
use x11rb::{CURRENT_TIME, NONE};

use super::{FetchContext, Target};

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
    current: Arc<Mutex<Option<FetchContext>>>,
}

/// The process-wide selection owner, created lazily on the first successful bind.
/// Held behind a `Mutex<Option<…>>` (not a bare `OnceLock`) so a bind attempted
/// before an X server is reachable can retry on a later bind rather than caching
/// the failure forever.
static OWNER: OnceLock<Mutex<Option<Owner>>> = OnceLock::new();

fn owner_slot() -> &'static Mutex<Option<Owner>> {
    OWNER.get_or_init(|| Mutex::new(None))
}

/// Bind `ctx`'s files onto the X11 `CLIPBOARD` selection with delayed rendering.
/// The bytes are fetched only on the actual paste.
pub(super) fn bind(ctx: FetchContext) -> anyhow::Result<()> {
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
        *current = Some(ctx);
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

        let current: Arc<Mutex<Option<FetchContext>>> = Arc::new(Mutex::new(None));

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
    current: Arc<Mutex<Option<FetchContext>>>,
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
    current: &Mutex<Option<FetchContext>>,
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

    // Map the requested target atom to a served payload format, refusing anything
    // we never advertised (e.g. a text/plain probe).
    let target = if req.target == atoms.uri_list {
        Target::UriList
    } else if req.target == atoms.gnome || req.target == atoms.mate {
        Target::GnomeCopiedFiles
    } else {
        return refuse(conn, req);
    };

    // Snapshot the context out of the lock, then fetch without holding it.
    let Some(ctx) = current.lock().ok().and_then(|slot| slot.clone()) else {
        return refuse(conn, req);
    };

    // Delayed render: fetch each promised file's bytes now (bounded memory) and
    // format the collected `file://` URIs for the requested target.
    let Some(data) = ctx.render(target) else {
        return refuse(conn, req);
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
