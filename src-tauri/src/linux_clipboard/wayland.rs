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
    let conn = Connection::connect_to_env()
        .map_err(|e| anyhow::anyhow!("failed to connect to the Wayland display: {e}"))?;

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
