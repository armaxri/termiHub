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

impl Atoms {
    /// The `TARGETS` answer: every target this owner converts to.
    fn advertised(&self) -> [Atom; 4] {
        [self.targets, self.uri_list, self.gnome, self.mate]
    }
}

/// How the owner answers a conversion request for one target atom.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Answer {
    /// `TARGETS`: list the advertised targets (no fetch).
    Targets,
    /// A file target: fetch the promised files and render this payload.
    Render(Target),
    /// A target we never advertised: refuse the conversion (no fetch).
    Refuse,
}

/// Map a requested target atom to the owner's answer. Pure over the interned
/// atoms, so the negotiation is unit-testable without an X server.
fn classify_target(atoms: &Atoms, target: Atom) -> Answer {
    if target == atoms.targets {
        Answer::Targets
    } else if target == atoms.uri_list {
        Answer::Render(Target::UriList)
    } else if target == atoms.gnome || target == atoms.mate {
        Answer::Render(Target::GnomeCopiedFiles)
    } else {
        Answer::Refuse
    }
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
    bind_on(None, ctx)
}

/// [`bind`] against an explicit X `display` (e.g. `":99"`), or the `DISPLAY`
/// environment variable when `None`. The display only matters for the first bind,
/// which creates the process-wide owner; split out so the Xvfb test can target its
/// own server without mutating the process environment (#4087).
fn bind_on(display: Option<&str>, ctx: FetchContext) -> anyhow::Result<()> {
    let mut slot = owner_slot()
        .lock()
        .map_err(|_| anyhow::anyhow!("clipboard owner lock poisoned"))?;
    if slot.is_none() {
        *slot = Some(Owner::start(display)?);
    }
    let owner = slot
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("clipboard owner missing after initialisation"))?;

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
    fn start(display: Option<&str>) -> anyhow::Result<Self> {
        let (conn, screen_num) = RustConnection::connect(display)
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

    let target = match classify_target(atoms, req.target) {
        Answer::Targets => {
            // Advertise what we can convert to.
            conn.change_property32(
                PropMode::REPLACE,
                req.requestor,
                property,
                AtomEnum::ATOM,
                &atoms.advertised(),
            )?;
            return send_notify(conn, req, property);
        }
        Answer::Render(target) => target,
        // Refuse anything we never advertised (e.g. a text/plain probe).
        Answer::Refuse => return refuse(conn, req),
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

/// Live X11 delayed-render paste under a private Xvfb server (#4087).
///
/// Owns `CLIPBOARD` with a fake fetcher and reads it back with `xclip`, proving
/// end to end that: nothing is fetched on copy (or on a `TARGETS` probe), a paste
/// of `text/uri-list` / `x-special/gnome-copied-files` runs the fetch and returns
/// the staged files' `file://` URIs (a non-ASCII name percent-encoded as UTF-8),
/// and an unadvertised target is refused without fetching.
///
/// Needs the `Xvfb` and `xclip` binaries; the test starts its own server via
/// `-displayfd` (never touching the developer's real clipboard) and skips with a
/// stated reason when either is missing. CI's ubuntu leg installs both and sets
/// `TERMIHUB_REQUIRE_X11_CLIPBOARD_TEST=1`, which turns that skip into a failure
/// so the test can never silently stop running.
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, Output, Stdio};
    use std::time::{Duration, Instant};

    /// A private Xvfb server, killed on drop.
    struct Xvfb {
        child: Child,
        display: String,
    }

    impl Drop for Xvfb {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    /// Whether `bin` resolves on `PATH`.
    fn on_path(bin: &str) -> bool {
        std::env::var_os("PATH")
            .is_some_and(|paths| std::env::split_paths(&paths).any(|dir| dir.join(bin).is_file()))
    }

    /// Start Xvfb on a free display chosen by the server itself (`-displayfd`
    /// writes the display number to the given fd — here its stdout).
    fn start_xvfb() -> Xvfb {
        let mut child = Command::new("Xvfb")
            .args([
                "-displayfd",
                "1",
                "-nolisten",
                "tcp",
                "-screen",
                "0",
                "64x64x24",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn Xvfb");
        let stdout = child.stdout.take().expect("Xvfb stdout");
        let mut line = String::new();
        BufReader::new(stdout)
            .read_line(&mut line)
            .expect("read the display number from Xvfb");
        let number = line.trim();
        assert!(
            !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()),
            "Xvfb reported no display number (got {line:?})"
        );
        Xvfb {
            display: format!(":{number}"),
            child,
        }
    }

    /// Run `xclip -o` for `target` on the `CLIPBOARD` selection of `display`,
    /// bounded so a broken owner fails the test instead of hanging it.
    fn xclip_out(display: &str, target: &str) -> Output {
        let mut child = Command::new("xclip")
            .args([
                "-display",
                display,
                "-selection",
                "clipboard",
                "-t",
                target,
                "-o",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn xclip");
        let deadline = Instant::now() + Duration::from_secs(20);
        while child.try_wait().expect("poll xclip").is_none() {
            if Instant::now() > deadline {
                let _ = child.kill();
                panic!("xclip -t {target} -o did not finish within 20s");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        child.wait_with_output().expect("collect xclip output")
    }

    /// A fake fetcher that "stages" index `i` as `files[i]` and records each call.
    fn fake_context(
        files: Vec<PathBuf>,
        indices: Vec<u32>,
        calls: Arc<Mutex<Vec<u32>>>,
    ) -> FetchContext {
        FetchContext {
            fetcher: super::super::Fetcher::Fake(Arc::new(move |index| {
                calls.lock().unwrap().push(index);
                files
                    .get(index as usize)
                    .cloned()
                    .ok_or_else(|| anyhow::anyhow!("no fake file at index {index}"))
            })),
            indices,
        }
    }

    fn calls_of(calls: &Arc<Mutex<Vec<u32>>>) -> Vec<u32> {
        calls.lock().unwrap().clone()
    }

    /// Distinct fake atom values, as an X server would intern them.
    fn fake_atoms() -> Atoms {
        Atoms {
            clipboard: 100,
            targets: 101,
            uri_list: 102,
            gnome: 103,
            mate: 104,
        }
    }

    #[test]
    fn classify_target_answers_targets_and_the_file_targets() {
        let atoms = fake_atoms();
        assert_eq!(classify_target(&atoms, 101), Answer::Targets);
        assert_eq!(
            classify_target(&atoms, 102),
            Answer::Render(Target::UriList)
        );
        assert_eq!(
            classify_target(&atoms, 103),
            Answer::Render(Target::GnomeCopiedFiles)
        );
        assert_eq!(
            classify_target(&atoms, 104),
            Answer::Render(Target::GnomeCopiedFiles)
        );
    }

    #[test]
    fn classify_target_refuses_unadvertised_targets() {
        let atoms = fake_atoms();
        // The selection atom itself, `None`, and any other interned atom (e.g. a
        // `UTF8_STRING` / `text/plain` probe) are refused, never served empty.
        for target in [100, NONE, 31, 999] {
            assert_eq!(classify_target(&atoms, target), Answer::Refuse, "{target}");
        }
    }

    #[test]
    fn advertised_targets_are_exactly_the_served_ones() {
        let atoms = fake_atoms();
        let advertised = atoms.advertised();
        assert_eq!(advertised, [101, 102, 103, 104]);
        for atom in advertised {
            assert_ne!(classify_target(&atoms, atom), Answer::Refuse);
        }
    }

    #[test]
    fn xvfb_paste_fetches_on_demand_and_serves_file_uris() {
        let missing: Vec<&str> = ["Xvfb", "xclip"]
            .into_iter()
            .filter(|bin| !on_path(bin))
            .collect();
        if !missing.is_empty() {
            let reason = format!(
                "skipping the X11 delayed-render paste test: {} not on PATH \
                 (install xvfb + xclip to run it)",
                missing.join(" and ")
            );
            assert!(
                std::env::var_os("TERMIHUB_REQUIRE_X11_CLIPBOARD_TEST").is_none(),
                "{reason}, but TERMIHUB_REQUIRE_X11_CLIPBOARD_TEST is set"
            );
            eprintln!("{reason}");
            return;
        }

        let xvfb = start_xvfb();

        // Staged "remote" files: index 1 is a directory the bind drops (only
        // regular files are pasteable), index 2 has a non-ASCII name with a space.
        let tmp = tempfile::tempdir().expect("create staging dir");
        let dir = tmp.path();
        let plain = dir.join("plain.txt");
        let unicode = dir.join("café ü.txt");
        std::fs::write(&plain, b"plain").expect("stage plain");
        std::fs::write(&unicode, b"unicode").expect("stage unicode");
        let remote = vec![
            termihub_core::connection::RemoteClipboardFile {
                name: "plain.txt".into(),
                relative_path: None,
                size: Some(5),
                is_dir: false,
                index: 0,
            },
            termihub_core::connection::RemoteClipboardFile {
                name: "folder".into(),
                relative_path: None,
                size: None,
                is_dir: true,
                index: 1,
            },
            termihub_core::connection::RemoteClipboardFile {
                name: "café ü.txt".into(),
                relative_path: None,
                size: Some(7),
                is_dir: false,
                index: 2,
            },
        ];
        let indices = super::super::pasteable_indices(&remote);
        assert_eq!(indices, vec![0, 2]);
        let staged = vec![plain.clone(), dir.join("folder"), unicode.clone()];

        let calls = Arc::new(Mutex::new(Vec::new()));
        bind_on(
            Some(&xvfb.display),
            fake_context(staged, indices, Arc::clone(&calls)),
        )
        .expect("own CLIPBOARD on the Xvfb display");

        // Copy moves no bytes.
        assert!(
            calls_of(&calls).is_empty(),
            "the bind itself must not fetch"
        );

        // A TARGETS probe advertises the file targets — still without fetching.
        let targets = xclip_out(&xvfb.display, "TARGETS");
        assert!(
            targets.status.success(),
            "TARGETS probe failed: {targets:?}"
        );
        let targets = String::from_utf8_lossy(&targets.stdout);
        for t in [
            "text/uri-list",
            "x-special/gnome-copied-files",
            "x-special/mate-copied-files",
        ] {
            assert!(
                targets.lines().any(|l| l == t),
                "{t} missing from TARGETS: {targets}"
            );
        }
        assert!(
            calls_of(&calls).is_empty(),
            "a TARGETS probe must not fetch"
        );

        let uri = |p: &Path| crate::utils::file_uri::path_to_file_uri(p);
        let encoded_name = "caf%C3%A9%20%C3%BC.txt";
        assert!(uri(&unicode).ends_with(encoded_name), "{}", uri(&unicode));

        // Paste text/uri-list: the fetch runs now, once per pasteable file.
        let out = xclip_out(&xvfb.display, "text/uri-list");
        assert!(out.status.success(), "uri-list paste failed: {out:?}");
        assert_eq!(
            String::from_utf8(out.stdout).expect("uri-list is UTF-8"),
            format!("{}\r\n{}\r\n", uri(&plain), uri(&unicode))
        );
        assert_eq!(calls_of(&calls), vec![0, 2], "paste fetches each file once");

        // Each paste is a fresh delayed render (gnome + mate variants).
        let gnome_payload = format!("copy\n{}\n{}", uri(&plain), uri(&unicode));
        for (target, expected_calls) in [
            ("x-special/gnome-copied-files", vec![0, 2, 0, 2]),
            ("x-special/mate-copied-files", vec![0, 2, 0, 2, 0, 2]),
        ] {
            let out = xclip_out(&xvfb.display, target);
            assert!(out.status.success(), "{target} paste failed: {out:?}");
            assert_eq!(String::from_utf8(out.stdout).unwrap(), gnome_payload);
            assert_eq!(calls_of(&calls), expected_calls);
        }

        // An unadvertised target is refused without fetching.
        let refused = xclip_out(&xvfb.display, "text/plain");
        assert!(
            !refused.status.success(),
            "text/plain must be refused: {refused:?}"
        );
        assert_eq!(calls_of(&calls).len(), 6, "a refused target must not fetch");
    }
}
