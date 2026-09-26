//! Remote resolution for VNC sessions (#3463): the RFB ExtendedDesktopSize
//! negotiation state behind the connection editor's **Resolution** row.
//!
//! - **Server** (the default, and the only behavior before #3463): the
//!   extension is not even advertised; the remote keeps the size its server
//!   chose and the canvas scales locally.
//! - **Fixed** `W x H`: once the server has shown it supports the extension
//!   (its first layout report), `SetDesktopSize` asks for the fixed size —
//!   exactly once per connection. A refusal is logged and the server's size is
//!   kept.
//! - **Dynamic**: every (debounced) panel-size request from the frontend
//!   becomes a `SetDesktopSize` when the server supports it. Requests are
//!   coalesced: while one is awaiting its reply, only the latest size is kept
//!   and sent after it. A server without the extension, or one that refuses,
//!   is reported back to the caller as a notice so the frontend can tell the
//!   user the remote is being scaled locally instead.
//!
//! This module is pure state (no I/O, time is passed in) so every transition
//! is unit-tested; the driver and `GraphicalBackend::resize` in `mod.rs` do the
//! sending.

use std::time::{Duration, Instant};

use tracing::{debug, warn};
use vnc::{
    DesktopScreen, DesktopSizeReason, DesktopSizeRequest, DesktopSizeStatus, ExtendedDesktopSize,
    VncEvent,
};

use crate::connection::graphical_resolution::{MAX_FIXED_DIMENSION, MIN_FIXED_DIMENSION};

/// How long a `SetDesktopSize` may await its reply before a newer request is
/// sent anyway, so a server that never answers cannot wedge dynamic resizing.
pub(super) const REPLY_TIMEOUT: Duration = Duration::from_secs(3);

/// The user's remote-resolution choice (see the module docs).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolutionMode {
    /// Keep the size the server chose.
    Server,
    /// Follow the tab through `SetDesktopSize`.
    Dynamic,
    /// Request this size once connected.
    Fixed { width: u16, height: u16 },
}

impl ResolutionMode {
    /// Whether the ExtendedDesktopSize pseudo-encoding is advertised. The
    /// server mode leaves it out so the session negotiates exactly as before.
    pub fn negotiates_layout(self) -> bool {
        !matches!(self, ResolutionMode::Server)
    }
}

/// What the server has shown about ExtendedDesktopSize so far.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Support {
    /// No framebuffer update yet.
    Unknown,
    /// The server sent a layout report.
    Supported,
    /// The server's first update carried no layout report.
    Unsupported,
}

/// The result of a dynamic resize request.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct ResizeOutcome {
    /// A `SetDesktopSize` to send now, if any.
    pub request: Option<DesktopSizeRequest>,
    /// A user-facing reason the remote is not (or was not) resized, if any.
    pub notice: Option<String>,
}

/// ExtendedDesktopSize negotiation state of one VNC connection.
#[derive(Debug)]
pub(super) struct DesktopSize {
    mode: ResolutionMode,
    support: Support,
    /// Current framebuffer size, from the latest accepted layout.
    current: (u16, u16),
    /// The server's latest screen layout (ids and flags are echoed back).
    screens: Vec<DesktopScreen>,
    /// The fixed size has been requested (fixed mode asks only once).
    fixed_requested: bool,
    /// When the outstanding `SetDesktopSize` was sent, if one awaits a reply.
    in_flight: Option<Instant>,
    /// The latest dynamic size not yet sent.
    pending: Option<(u16, u16)>,
    /// The server answered "resize prohibited": stop asking.
    prohibited: bool,
    /// A refusal not yet reported to a dynamic resize caller.
    refusal: Option<String>,
}

impl DesktopSize {
    pub(super) fn new(mode: ResolutionMode) -> Self {
        Self {
            mode,
            support: Support::Unknown,
            current: (0, 0),
            screens: Vec::new(),
            fixed_requested: false,
            in_flight: None,
            pending: None,
            prohibited: false,
            refusal: None,
        }
    }

    /// Whether this session can currently follow the tab (dynamic mode on a
    /// server not known to lack, or to prohibit, client-side resizing).
    pub(super) fn supports_dynamic_resize(&self) -> bool {
        self.mode == ResolutionMode::Dynamic
            && self.support != Support::Unsupported
            && !self.prohibited
    }

    /// Feed a decoded RFB event; returns a `SetDesktopSize` to send, if the
    /// event made one due. Events other than the layout ones are ignored.
    pub(super) fn on_event(
        &mut self,
        event: &VncEvent,
        now: Instant,
    ) -> Option<DesktopSizeRequest> {
        match event {
            VncEvent::SetResolution(screen) => {
                self.current = (screen.width, screen.height);
                None
            }
            VncEvent::DesktopLayout(layout) => self.on_layout(layout, now),
            VncEvent::DesktopLayoutUnsupported => {
                self.on_unsupported();
                None
            }
            _ => None,
        }
    }

    fn on_layout(
        &mut self,
        layout: &ExtendedDesktopSize,
        now: Instant,
    ) -> Option<DesktopSizeRequest> {
        self.support = Support::Supported;
        if layout.status == DesktopSizeStatus::Ok {
            self.current = (layout.width, layout.height);
            if !layout.screens.is_empty() {
                self.screens = layout.screens.clone();
            }
        }
        if layout.reason == DesktopSizeReason::Client {
            self.in_flight = None;
            if layout.status != DesktopSizeStatus::Ok {
                self.record_refusal(layout.status);
            }
        }
        self.next_request(now)
    }

    fn on_unsupported(&mut self) {
        self.support = Support::Unsupported;
        self.pending = None;
        let (w, h) = self.current;
        match self.mode {
            ResolutionMode::Fixed { width, height } => warn!(
                width,
                height,
                "VNC server does not support ExtendedDesktopSize; keeping its {w}x{h} desktop"
            ),
            ResolutionMode::Dynamic => debug!(
                "VNC server does not support ExtendedDesktopSize; dynamic resize unavailable"
            ),
            ResolutionMode::Server => {}
        }
    }

    fn record_refusal(&mut self, status: DesktopSizeStatus) {
        let (w, h) = self.current;
        let why = match status {
            DesktopSizeStatus::Prohibited => {
                self.prohibited = true;
                self.pending = None;
                "the server does not allow clients to resize the desktop".to_string()
            }
            DesktopSizeStatus::OutOfResources => {
                "the server is out of resources for that size".to_string()
            }
            DesktopSizeStatus::InvalidLayout => {
                "the server rejected the requested screen layout".to_string()
            }
            DesktopSizeStatus::Unknown(code) => format!("the server refused it (status {code})"),
            DesktopSizeStatus::Ok => return,
        };
        let msg = format!(
            "The VNC desktop was not resized: {why}. Keeping {w}x{h} and scaling it locally."
        );
        warn!(?status, "{msg}");
        self.refusal = Some(msg);
    }

    /// A dynamic resize to the panel size `width x height` (clamped to the
    /// shared 200..=8192 range). A no-op outside the dynamic mode — the server
    /// and fixed modes never follow the tab.
    pub(super) fn request(&mut self, width: u16, height: u16, now: Instant) -> ResizeOutcome {
        if self.mode != ResolutionMode::Dynamic {
            return ResizeOutcome::default();
        }
        let size = (
            width.clamp(MIN_FIXED_DIMENSION, MAX_FIXED_DIMENSION),
            height.clamp(MIN_FIXED_DIMENSION, MAX_FIXED_DIMENSION),
        );
        if self.support == Support::Unsupported {
            let (w, h) = self.current;
            return ResizeOutcome {
                request: None,
                notice: Some(format!(
                    "This VNC server does not support resizing the desktop from the client \
                     (RFB ExtendedDesktopSize). Keeping {w}x{h} and scaling it locally."
                )),
            };
        }
        if self.prohibited {
            // Re-surface the refusal while one is unreported; afterwards stay quiet.
            return ResizeOutcome {
                request: None,
                notice: self.refusal.take(),
            };
        }
        self.pending = Some(size);
        ResizeOutcome {
            request: self.next_request(now),
            notice: self.refusal.take(),
        }
    }

    /// The `SetDesktopSize` due now, if any: none before the server confirmed
    /// support, while a request awaits its reply (up to [`REPLY_TIMEOUT`]), or
    /// when the target already is the current size.
    fn next_request(&mut self, now: Instant) -> Option<DesktopSizeRequest> {
        if self.support != Support::Supported || self.prohibited {
            return None;
        }
        if let Some(sent) = self.in_flight {
            if now.saturating_duration_since(sent) < REPLY_TIMEOUT {
                return None;
            }
        }
        let target = match self.mode {
            ResolutionMode::Server => None,
            ResolutionMode::Dynamic => self.pending.take(),
            ResolutionMode::Fixed { width, height } => {
                (!self.fixed_requested).then_some((width, height))
            }
        }?;
        self.fixed_requested = true;
        if target == self.current {
            return None;
        }
        self.in_flight = Some(now);
        Some(self.layout_for(target))
    }

    /// A single-screen layout of `size`, keeping the id and flags of the
    /// server's first screen (the approach noVNC and TigerVNC's viewer take
    /// for a window-sized desktop).
    fn layout_for(&self, (width, height): (u16, u16)) -> DesktopSizeRequest {
        let base = self.screens.first();
        DesktopSizeRequest {
            width,
            height,
            screens: vec![DesktopScreen {
                id: base.map_or(0, |s| s.id),
                x: 0,
                y: 0,
                width,
                height,
                flags: base.map_or(0, |s| s.flags),
            }],
        }
    }
}

#[cfg(test)]
#[path = "desktop_size_tests.rs"]
mod tests;
