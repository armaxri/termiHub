//! The native-Wayland `wlr-data-control` delayed data source (#1847).
//!
//! ## Why a low-level data-control source
//!
//! Native-only Wayland clients read the clipboard over the compositor's
//! **`wlr-data-control`** protocol and never touch XWayland, so the #1815 X11
//! `CLIPBOARD` owner does not reach them. The in-tree `wl-clipboard-rs` (the
//! sidecar's reader) can *set* a Wayland selection, but only from **fixed bytes**
//! (`Source::Bytes` / `Source::StdIn`) — its data source has no per-request
//! callback, so it cannot fetch a remote file's bytes lazily at the paste. Delayed
//! rendering therefore needs the raw protocol.
//!
//! `wlr-data-control` gives exactly the ownership model X11 selections do: a client
//! **owns a data source** advertising target MIME types, and the compositor
//! delivers a **`send(mime_type, fd)`** event when another client pastes. We
//! produce the bytes only in that callback — the delayed render — via
//! [`FetchContext::render`](super::FetchContext::render), mirroring the X11 owner's
//! `SelectionRequest` handler.
//!
//! ## The owner thread
//!
//! [`bind`] connects to the Wayland display, binds the
//! `zwlr_data_control_manager_v1` global (returning an error the caller treats as
//! "no native Wayland support, fall back to X11" when the compositor lacks it),
//! creates a data source offering `text/uri-list` +
//! `x-special/gnome-copied-files` / `x-special/mate-copied-files`, and sets it as
//! the selection. It then runs a blocking dispatch loop on a **dedicated thread**
//! that serves each `send` and exits on `cancelled` — the compositor sends
//! `cancelled` to the previous source whenever a newer selection (another app, or
//! our own next bind) replaces it, so a stale promise is never served and old
//! owner threads retire themselves. This is the Wayland analog of the X11 owner
//! thread and the macOS/Windows pasteboard owners.

use std::io::Write;

use wayland_client::globals::{registry_queue_init, GlobalListContents};
use wayland_client::protocol::{wl_registry::WlRegistry, wl_seat::WlSeat};
use wayland_client::{delegate_noop, event_created_child, Connection, Dispatch, QueueHandle};
use wayland_protocols_wlr::data_control::v1::client::zwlr_data_control_device_v1::{
    self, ZwlrDataControlDeviceV1, EVT_DATA_OFFER_OPCODE,
};
use wayland_protocols_wlr::data_control::v1::client::zwlr_data_control_manager_v1::ZwlrDataControlManagerV1;
use wayland_protocols_wlr::data_control::v1::client::zwlr_data_control_offer_v1::ZwlrDataControlOfferV1;
use wayland_protocols_wlr::data_control::v1::client::zwlr_data_control_source_v1::{
    self, ZwlrDataControlSourceV1,
};

use super::{FetchContext, Target};

/// The MIME types the data source advertises, in the order file managers prefer.
const OFFERED_MIMES: [&str; 3] = [
    "text/uri-list",
    "x-special/gnome-copied-files",
    "x-special/mate-copied-files",
];

/// The serving-thread state: how to fetch the promised files, plus a flag the
/// dispatch loop watches to retire the source.
struct WaylandOwner {
    ctx: FetchContext,
    /// Set once the source is cancelled or the device is finished — the compositor
    /// has handed the selection to someone else, so this owner must stop serving.
    finished: bool,
}

/// Set `ctx`'s files as the native Wayland selection with delayed rendering.
///
/// Returns an error (so the caller falls back to the X11/XWayland owner) when no
/// Wayland display is reachable or the compositor does not implement
/// `wlr-data-control`. On success, ownership + serving continue on a detached
/// thread for as long as this source stays the selection.
pub(super) fn bind(ctx: FetchContext) -> anyhow::Result<()> {
    bind_on(None, ctx)
}

/// [`bind`] against an explicit compositor `socket` (`None` = the session's
/// `WAYLAND_DISPLAY`), so tests can target a private headless compositor
/// without mutating the process environment.
fn bind_on(socket: Option<&std::path::Path>, ctx: FetchContext) -> anyhow::Result<()> {
    let conn = match socket {
        None => Connection::connect_to_env()
            .map_err(|e| anyhow::anyhow!("failed to connect to the Wayland display: {e}"))?,
        Some(path) => {
            let stream = std::os::unix::net::UnixStream::connect(path)
                .map_err(|e| anyhow::anyhow!("failed to connect to {}: {e}", path.display()))?;
            Connection::from_socket(stream)
                .map_err(|e| anyhow::anyhow!("failed to connect to the Wayland display: {e}"))?
        }
    };

    let (globals, mut queue) = registry_queue_init::<WaylandOwner>(&conn)
        .map_err(|e| anyhow::anyhow!("failed to initialise the Wayland registry: {e}"))?;
    let qh = queue.handle();

    // The manager global is the compositor's `wlr-data-control` support. Its absence
    // is the "fall back to X11" signal, not a hard failure.
    let manager: ZwlrDataControlManagerV1 = globals.bind(&qh, 1..=1, ()).map_err(|e| {
        anyhow::anyhow!("compositor does not support wlr-data-control (no manager): {e}")
    })?;
    let seat: WlSeat = globals
        .bind(&qh, 1..=1, ())
        .map_err(|e| anyhow::anyhow!("no Wayland seat available: {e}"))?;

    // Advertise the file targets on a fresh data source, then claim the selection.
    let source = manager.create_data_source(&qh, ());
    for mime in OFFERED_MIMES {
        source.offer(mime.to_string());
    }
    let device = manager.get_data_device(&seat, &qh, ());
    device.set_selection(Some(&source));

    let mut state = WaylandOwner {
        ctx,
        finished: false,
    };
    // Round-trip so the set_selection request is processed and any immediate
    // protocol error surfaces here (→ X11 fallback) rather than after we detach.
    queue
        .roundtrip(&mut state)
        .map_err(|e| anyhow::anyhow!("failed to claim the Wayland selection: {e}"))?;

    // Serve conversions on a dedicated thread for as long as we own the selection.
    // The proxies are moved in to keep the source/device/manager alive; `conn` must
    // outlive the queue, so it moves in too.
    std::thread::Builder::new()
        .name("termihub-wl-clipboard-owner".to_string())
        .spawn(move || {
            let _keep_alive = (conn, manager, seat, device, source);
            while !state.finished {
                if let Err(e) = queue.blocking_dispatch(&mut state) {
                    tracing::warn!("Wayland clipboard owner dispatch ended: {e}");
                    break;
                }
            }
        })
        .map_err(|e| anyhow::anyhow!("failed to spawn Wayland clipboard owner thread: {e}"))?;

    Ok(())
}

/// Serve one `send`: fetch the promised files (the delayed render) and write the
/// requested payload to the compositor-provided pipe. The payload is only the
/// `file://` URI list — small, so a single blocking write cannot stall the loop —
/// while the file *bytes* land in the sidecar's staging files the URIs point at.
impl Dispatch<ZwlrDataControlSourceV1, ()> for WaylandOwner {
    fn event(
        state: &mut Self,
        source: &ZwlrDataControlSourceV1,
        event: zwlr_data_control_source_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            zwlr_data_control_source_v1::Event::Send { mime_type, fd } => {
                // Refuse a target we never advertised by simply closing the pipe
                // (dropping `fd`), which the requestor reads as an empty transfer.
                let Some(target) = Target::from_mime(&mime_type) else {
                    return;
                };
                let Some(data) = state.ctx.render(target) else {
                    return;
                };
                let mut pipe = std::fs::File::from(fd);
                if let Err(e) = pipe.write_all(&data) {
                    tracing::warn!("failed to write Wayland clipboard payload to requestor: {e}");
                }
                // `pipe` (and thus the fd) is closed on drop, signalling EOF.
            }
            zwlr_data_control_source_v1::Event::Cancelled => {
                // The selection moved to another owner: stop serving and retire.
                source.destroy();
                state.finished = true;
            }
            _ => {}
        }
    }
}

/// The data device delivers offers/selection notifications for the current
/// clipboard (including our own). We only *set* the selection, so we ignore them —
/// but a `data_offer` event creates a child object wayland-client must be told how
/// to construct, and a `finished` event means the device is gone.
impl Dispatch<ZwlrDataControlDeviceV1, ()> for WaylandOwner {
    fn event(
        state: &mut Self,
        _: &ZwlrDataControlDeviceV1,
        event: zwlr_data_control_device_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let zwlr_data_control_device_v1::Event::Finished = event {
            state.finished = true;
        }
    }

    event_created_child!(WaylandOwner, ZwlrDataControlDeviceV1, [
        EVT_DATA_OFFER_OPCODE => (ZwlrDataControlOfferV1, ()),
    ]);
}

// The registry (enumerated by `registry_queue_init`), the manager (no events), the
// seat, and incoming data offers carry nothing we act on.
impl Dispatch<WlRegistry, GlobalListContents> for WaylandOwner {
    fn event(
        _: &mut Self,
        _: &WlRegistry,
        _: <WlRegistry as wayland_client::Proxy>::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

delegate_noop!(WaylandOwner: ZwlrDataControlManagerV1);
delegate_noop!(WaylandOwner: ignore WlSeat);
delegate_noop!(WaylandOwner: ignore ZwlrDataControlOfferV1);

#[cfg(test)]
mod tests {
    //! Live native-Wayland delayed-render paste (#1847, #4004): a private headless
    //! `sway` (wlroots, implements `wlr-data-control`) stands in for the desktop
    //! compositor and `wl-paste` for a native Wayland file manager. Skips when
    //! either is missing unless `TERMIHUB_REQUIRE_WAYLAND_CLIPBOARD_TEST` is set
    //! (the ubuntu CI leg installs both and sets it).

    use super::*;
    use crate::linux_clipboard::Fetcher;
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, Output, Stdio};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    fn on_path(bin: &str) -> bool {
        std::env::var_os("PATH")
            .is_some_and(|paths| std::env::split_paths(&paths).any(|dir| dir.join(bin).is_file()))
    }

    /// A headless sway on a private `XDG_RUNTIME_DIR`; killed on drop.
    struct Sway {
        child: Child,
        runtime_dir: tempfile::TempDir,
        socket_name: String,
    }

    impl Sway {
        fn socket(&self) -> PathBuf {
            self.runtime_dir.path().join(&self.socket_name)
        }
    }

    impl Drop for Sway {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    /// Start sway with the headless wlroots backend (no GPU, no input devices)
    /// and wait for its Wayland socket to appear in the private runtime dir.
    fn start_sway() -> Sway {
        let runtime_dir = tempfile::tempdir().expect("create XDG_RUNTIME_DIR");
        let config = runtime_dir.path().join("sway.conf");
        std::fs::write(&config, "").expect("write empty sway config");
        let mut child = Command::new("sway")
            .arg("--config")
            .arg(&config)
            .env("XDG_RUNTIME_DIR", runtime_dir.path())
            .env("WLR_BACKENDS", "headless")
            .env("WLR_RENDERER", "pixman")
            .env("WLR_LIBINPUT_NO_DEVICES", "1")
            .env_remove("WAYLAND_DISPLAY")
            .env_remove("DISPLAY")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sway");
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let socket = std::fs::read_dir(runtime_dir.path())
                .expect("read XDG_RUNTIME_DIR")
                .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
                .find(|name| name.starts_with("wayland-") && !name.ends_with(".lock"));
            if let Some(socket_name) = socket {
                return Sway {
                    child,
                    runtime_dir,
                    socket_name,
                };
            }
            if let Some(status) = child.try_wait().expect("poll sway") {
                panic!("headless sway exited before creating its socket: {status}");
            }
            assert!(
                Instant::now() < deadline,
                "headless sway created no Wayland socket within 20s"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// Run `wl-paste <args>` against `sway`, bounded so a broken source fails
    /// the test instead of hanging it.
    fn wl_paste(sway: &Sway, args: &[&str]) -> Output {
        let mut child = Command::new("wl-paste")
            .args(args)
            .env("XDG_RUNTIME_DIR", sway.runtime_dir.path())
            .env("WAYLAND_DISPLAY", &sway.socket_name)
            .env_remove("DISPLAY")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn wl-paste");
        let deadline = Instant::now() + Duration::from_secs(20);
        while child.try_wait().expect("poll wl-paste").is_none() {
            if Instant::now() > deadline {
                let _ = child.kill();
                panic!("wl-paste {args:?} did not finish within 20s");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        child.wait_with_output().expect("collect wl-paste output")
    }

    #[test]
    fn headless_sway_paste_fetches_on_demand_and_serves_file_uris() {
        let missing: Vec<&str> = ["sway", "wl-paste"]
            .into_iter()
            .filter(|bin| !on_path(bin))
            .collect();
        if !missing.is_empty() {
            let reason = format!(
                "skipping the Wayland delayed-render paste test: {} not on PATH \
                 (install sway + wl-clipboard to run it)",
                missing.join(" and ")
            );
            assert!(
                std::env::var_os("TERMIHUB_REQUIRE_WAYLAND_CLIPBOARD_TEST").is_none(),
                "{reason}, but TERMIHUB_REQUIRE_WAYLAND_CLIPBOARD_TEST is set"
            );
            eprintln!("{reason}");
            return;
        }

        let sway = start_sway();

        // Staged "remote" files, one with a non-ASCII name and a space.
        let tmp = tempfile::tempdir().expect("create staging dir");
        let plain = tmp.path().join("plain.txt");
        let unicode = tmp.path().join("café ü.txt");
        std::fs::write(&plain, b"plain").expect("stage plain");
        std::fs::write(&unicode, b"unicode").expect("stage unicode");
        let staged = [plain.clone(), unicode.clone()];
        let calls = Arc::new(Mutex::new(Vec::<u32>::new()));
        let recorded = Arc::clone(&calls);
        let ctx = FetchContext {
            fetcher: Fetcher::Fake(Arc::new(move |index| {
                recorded.lock().unwrap().push(index);
                staged
                    .get(index as usize)
                    .cloned()
                    .ok_or_else(|| anyhow::anyhow!("no fake file at index {index}"))
            })),
            indices: vec![0, 1],
        };
        let calls_now = || calls.lock().unwrap().clone();

        bind_on(Some(&sway.socket()), ctx).expect("own the selection on headless sway");
        assert!(calls_now().is_empty(), "the bind itself must not fetch");

        // Listing the offered types (what a file manager does on focus) does
        // not fetch either.
        let types = wl_paste(&sway, &["--list-types"]);
        assert!(types.status.success(), "--list-types failed: {types:?}");
        let types = String::from_utf8_lossy(&types.stdout);
        for mime in OFFERED_MIMES {
            assert!(
                types.lines().any(|l| l == mime),
                "{mime} missing from the offer: {types}"
            );
        }
        assert!(calls_now().is_empty(), "listing types must not fetch");

        let uri = |p: &Path| crate::utils::file_uri::path_to_file_uri(p);
        assert!(
            uri(&unicode).ends_with("caf%C3%A9%20%C3%BC.txt"),
            "{}",
            uri(&unicode)
        );

        // Paste text/uri-list: the fetch runs now, once per file.
        let out = wl_paste(&sway, &["--no-newline", "--type", "text/uri-list"]);
        assert!(out.status.success(), "uri-list paste failed: {out:?}");
        assert_eq!(
            String::from_utf8(out.stdout).expect("uri-list is UTF-8"),
            format!("{}\r\n{}\r\n", uri(&plain), uri(&unicode))
        );
        assert_eq!(calls_now(), vec![0, 1], "paste fetches each file once");

        // Each paste is a fresh delayed render.
        let out = wl_paste(
            &sway,
            &["--no-newline", "--type", "x-special/gnome-copied-files"],
        );
        assert!(out.status.success(), "gnome paste failed: {out:?}");
        assert_eq!(
            String::from_utf8(out.stdout).unwrap(),
            format!("copy\n{}\n{}", uri(&plain), uri(&unicode))
        );
        assert_eq!(calls_now(), vec![0, 1, 0, 1]);

        // A type the source never offered is not served and fetches nothing.
        let refused = wl_paste(&sway, &["--no-newline", "--type", "text/plain"]);
        assert!(
            !refused.status.success() || refused.stdout.is_empty(),
            "text/plain must not be served: {refused:?}"
        );
        assert_eq!(calls_now().len(), 4, "an unoffered type must not fetch");
    }
}
