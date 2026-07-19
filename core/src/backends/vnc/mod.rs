//! VNC (RFB) graphical remote-desktop backend.
//!
//! Implements the protocol-agnostic [`GraphicalBackend`] trait (#1680) over the
//! RFB wire protocol using the `vnc-rs` client. Decode happens here, in Rust:
//! the backend negotiates the connection, decodes framebuffer updates into the
//! shared [`FrameUpdate`] / [`CursorUpdate`] stream, translates the shared
//! [`InputEvent`]s into RFB `KeyEvent` / `PointerEvent`, and bridges the
//! clipboard via RFB `ServerCutText` / `ClientCutText`. Everything the user
//! touches — canvas, toolbar, overlays, input, clipboard, scaling — belongs to
//! the shared layer and is untouched here; this module is the wire adapter only.
//!
//! It drops in beside the mock (#1680) and the coming RDP backend (#1682) under
//! the same trait: a new `backends/vnc/` module, a schema, and one additive
//! registry `register(...)` call — no shared match arm, no editor switch.

mod config;
mod frame;
mod keymap;
mod tunnel;

pub use config::vnc_settings_schema;

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use tokio::sync::mpsc;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};
use vnc::{
    ClientKeyEvent, ClientMouseEvent, PixelFormat, VncConnector, VncEncoding, VncError, VncEvent,
    VncVersion, X11Event,
};

use crate::connection::{
    AuthKind, Capabilities, ConnectionType, CursorReceiver, CursorShape, CursorUpdate, DirtyRect,
    FrameReceiver, FrameUpdate, GraphicalBackend, GraphicalCapabilities, InputEvent,
    OutputReceiver, SettingsSchema,
};
use crate::errors::SessionError;
use crate::files::FileBrowser;
use crate::monitoring::MonitoringProvider;

use config::VncConfig;
use frame::FrameShadow;

/// Bounded channel depth for frames / cursor updates (backpressure).
const CHANNEL_DEPTH: usize = 16;

/// How often the driver polls decoded events and drives incremental refreshes.
const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(30);

/// Shared, interior-mutable state touched by both the driver task and the
/// `GraphicalBackend` command methods.
struct VncShared {
    /// Latest remote clipboard text (RFB `ServerCutText`), surfaced via `get_clipboard`.
    clipboard: Mutex<String>,
    /// Last pointer X/Y (framebuffer pixels), so a server cursor-shape update can
    /// be positioned even though RFB carries no server cursor *position*.
    ptr_x: AtomicU32,
    ptr_y: AtomicU32,
    /// Suppress input when the session is view-only.
    view_only: bool,
    /// Whether server cursor shapes are rendered.
    show_remote_cursor: bool,
}

/// Live runtime of a connected VNC session.
struct VncRuntime {
    /// A clone of the RFB client for sending input / clipboard (methods take `&self`).
    client: vnc::VncClient,
    shared: Arc<VncShared>,
    cancel: CancellationToken,
    /// SSH tunnel kept alive for the session lifetime, if the transport uses one.
    _tunnel: Option<tunnel::SshTunnel>,
}

/// VNC/RFB graphical remote-desktop connection.
pub struct Vnc {
    runtime: Option<Arc<VncRuntime>>,
    frame_rx: StdMutex<Option<FrameReceiver>>,
    cursor_rx: StdMutex<Option<CursorReceiver>>,
    task: Option<JoinHandle<()>>,
}

impl Vnc {
    /// Create a new, disconnected VNC backend.
    pub fn new() -> Self {
        Self {
            runtime: None,
            frame_rx: StdMutex::new(None),
            cursor_rx: StdMutex::new(None),
            task: None,
        }
    }
}

impl Default for Vnc {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for Vnc {
    fn drop(&mut self) {
        if let Some(rt) = &self.runtime {
            rt.cancel.cancel();
        }
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

/// Translate a DOM `MouseEvent.buttons` bitmask (bit0 left, bit1 right, bit2
/// middle) into an RFB pointer button mask (RFC 6143 §7.5.5: bit0 button1/left,
/// bit1 button2/middle, bit2 button3/right).
fn dom_buttons_to_rfb(buttons: u8) -> u8 {
    let mut rfb = 0u8;
    if buttons & 0b001 != 0 {
        rfb |= 1 << 0; // left → button 1
    }
    if buttons & 0b010 != 0 {
        rfb |= 1 << 2; // DOM right → button 3
    }
    if buttons & 0b100 != 0 {
        rfb |= 1 << 1; // DOM middle → button 2
    }
    rfb
}

/// Encode the chosen client encodings for `cfg`, honoring the raw/ZRLE
/// preference and whether the remote cursor is wanted. `Raw` is always included
/// (RFC requirement); `DesktopSizePseudo` lets the server announce resolution
/// changes.
fn encodings_for(cfg: &VncConfig) -> Vec<VncEncoding> {
    let mut encs = Vec::new();
    if !cfg.prefers_raw() {
        encs.push(VncEncoding::Zrle);
    }
    encs.push(VncEncoding::CopyRect);
    encs.push(VncEncoding::Raw);
    if cfg.show_remote_cursor {
        encs.push(VncEncoding::CursorPseudo);
    }
    encs.push(VncEncoding::DesktopSizePseudo);
    encs
}

impl Vnc {
    /// Send a protocol-agnostic input event to the remote, translated to RFB.
    async fn forward_input(rt: &VncRuntime, event: InputEvent) -> Result<(), SessionError> {
        if rt.shared.view_only {
            return Ok(());
        }
        match event {
            InputEvent::Key { code, pressed } => {
                if let Some(keysym) = keymap::code_to_keysym(&code) {
                    rt.client
                        .input(X11Event::KeyEvent(ClientKeyEvent {
                            keycode: keysym,
                            down: pressed,
                        }))
                        .await
                        .map_err(map_vnc_err)?;
                }
            }
            InputEvent::Pointer { x, y, buttons } => {
                rt.shared.ptr_x.store(x, Ordering::Relaxed);
                rt.shared.ptr_y.store(y, Ordering::Relaxed);
                rt.client
                    .input(X11Event::PointerEvent(ClientMouseEvent {
                        position_x: x as u16,
                        position_y: y as u16,
                        bottons: dom_buttons_to_rfb(buttons),
                    }))
                    .await
                    .map_err(map_vnc_err)?;
            }
            InputEvent::Wheel {
                x,
                y,
                delta_x: _,
                delta_y,
            } => {
                rt.shared.ptr_x.store(x, Ordering::Relaxed);
                rt.shared.ptr_y.store(y, Ordering::Relaxed);
                // RFB models the wheel as button 4 (up) / button 5 (down):
                // a press followed immediately by a release.
                if delta_y != 0.0 {
                    let bit = if delta_y < 0.0 { 1 << 3 } else { 1 << 4 };
                    let (px, py) = (x as u16, y as u16);
                    rt.client
                        .input(X11Event::PointerEvent(ClientMouseEvent {
                            position_x: px,
                            position_y: py,
                            bottons: bit,
                        }))
                        .await
                        .map_err(map_vnc_err)?;
                    rt.client
                        .input(X11Event::PointerEvent(ClientMouseEvent {
                            position_x: px,
                            position_y: py,
                            bottons: 0,
                        }))
                        .await
                        .map_err(map_vnc_err)?;
                }
            }
        }
        Ok(())
    }
}

/// Map a `vnc-rs` error to a [`SessionError`], distinguishing auth rejection so
/// the message is actionable.
fn map_vnc_err(e: VncError) -> SessionError {
    match e {
        VncError::WrongPassword => {
            SessionError::SpawnFailed("VNC authentication failed: wrong password".to_string())
        }
        VncError::NoPassword => SessionError::InvalidConfig(
            "VNC server requires a password but none was provided".to_string(),
        ),
        other => SessionError::SpawnFailed(format!("VNC error: {other}")),
    }
}

/// The driver task: polls decoded RFB events, maintains the shadow framebuffer,
/// emits shared frame/cursor updates, mirrors the clipboard, and drives
/// incremental framebuffer-update requests. Ends when cancelled or on RFB error.
async fn drive(
    client: vnc::VncClient,
    shared: Arc<VncShared>,
    cancel: CancellationToken,
    frame_tx: mpsc::Sender<FrameUpdate>,
    cursor_tx: mpsc::Sender<CursorUpdate>,
) {
    let mut shadow = FrameShadow::new();
    // Prime the first full frame.
    if client.input(X11Event::FullRefresh).await.is_err() {
        return;
    }
    let mut request_outstanding = true;

    let mut ticker = tokio::time::interval(POLL_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            _ = ticker.tick() => {
                let mut got_event = false;
                loop {
                    match client.poll_event().await {
                        Ok(Some(event)) => {
                            got_event = true;
                            if !handle_event(event, &mut shadow, &shared, &frame_tx, &cursor_tx).await {
                                return; // channel closed downstream — session gone
                            }
                        }
                        Ok(None) => break,
                        Err(e) => {
                            debug!(error = %e, "vnc session ended");
                            return;
                        }
                    }
                }
                // Keep exactly one incremental request outstanding: refill it
                // once the previous one has been answered, so an idle desktop
                // doesn't pile up requests and input stays responsive.
                if got_event {
                    request_outstanding = false;
                }
                if !request_outstanding {
                    if client.input(X11Event::Refresh).await.is_err() {
                        return;
                    }
                    request_outstanding = true;
                }
            }
        }
    }
}

/// Handle one decoded RFB event. Returns `false` if a downstream channel closed
/// (the session should end).
async fn handle_event(
    event: VncEvent,
    shadow: &mut FrameShadow,
    shared: &VncShared,
    frame_tx: &mpsc::Sender<FrameUpdate>,
    cursor_tx: &mpsc::Sender<CursorUpdate>,
) -> bool {
    match event {
        VncEvent::SetResolution(screen) => {
            shadow.resize(screen.width as u32, screen.height as u32);
            // Resize the canvas; the server repaints on the next request.
            frame_tx
                .send(FrameUpdate {
                    width: shadow.width(),
                    height: shadow.height(),
                    rects: Vec::new(),
                })
                .await
                .is_ok()
        }
        VncEvent::RawImage(rect, data) => {
            let (x, y, w, h) = (
                rect.x as u32,
                rect.y as u32,
                rect.width as u32,
                rect.height as u32,
            );
            // Cope with a full frame arriving before any resolution event.
            if shadow.width() == 0 || shadow.height() == 0 {
                shadow.resize(x + w, y + h);
            }
            if data.len() != (w as usize) * (h as usize) * 4 {
                warn!(
                    w,
                    h,
                    len = data.len(),
                    "vnc raw image size mismatch — dropped"
                );
                return true;
            }
            shadow.blit(x, y, w, h, &data);
            frame_tx
                .send(FrameUpdate {
                    width: shadow.width(),
                    height: shadow.height(),
                    rects: vec![DirtyRect {
                        x,
                        y,
                        width: w,
                        height: h,
                        data,
                    }],
                })
                .await
                .is_ok()
        }
        VncEvent::Copy(dst, src) => {
            let (w, h) = (dst.width as u32, dst.height as u32);
            if !shadow.copy_rect(dst.x as u32, dst.y as u32, src.x as u32, src.y as u32, w, h) {
                return true;
            }
            let Some(data) = shadow.extract(dst.x as u32, dst.y as u32, w, h) else {
                return true;
            };
            frame_tx
                .send(FrameUpdate {
                    width: shadow.width(),
                    height: shadow.height(),
                    rects: vec![DirtyRect {
                        x: dst.x as u32,
                        y: dst.y as u32,
                        width: w,
                        height: h,
                        data,
                    }],
                })
                .await
                .is_ok()
        }
        VncEvent::SetCursor(rect, data) => {
            if !shared.show_remote_cursor {
                return true;
            }
            let (w, h) = (rect.width as u32, rect.height as u32);
            let shape = if w == 0 || h == 0 || data.len() != (w as usize) * (h as usize) * 4 {
                None // empty / malformed cursor → hide
            } else {
                Some(CursorShape {
                    width: w,
                    height: h,
                    hotspot_x: rect.x as u32,
                    hotspot_y: rect.y as u32,
                    data,
                })
            };
            cursor_tx
                .send(CursorUpdate {
                    x: shared.ptr_x.load(Ordering::Relaxed),
                    y: shared.ptr_y.load(Ordering::Relaxed),
                    visible: shape.is_some(),
                    shape,
                })
                .await
                .is_ok()
        }
        VncEvent::Text(text) => {
            *shared.clipboard.lock().await = text;
            true
        }
        VncEvent::Error(msg) => {
            warn!(%msg, "vnc protocol error");
            false
        }
        // JpegImage (Tight, not negotiated), Bell, SetPixelFormat — no shared
        // surface to route to; safely ignored.
        _ => true,
    }
}

#[async_trait::async_trait]
impl ConnectionType for Vnc {
    fn type_id(&self) -> &str {
        "vnc"
    }

    fn display_name(&self) -> &str {
        "VNC"
    }

    fn settings_schema(&self) -> SettingsSchema {
        vnc_settings_schema()
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            monitoring: false,
            file_browser: false,
            // Graphical + terminal-less: routed through the GraphicalSessionManager
            // into a remote-desktop canvas tab. `graphical: true` also gates it as
            // experimental (#1705) with no per-protocol wiring.
            graphical: true,
            resize: false,
            persistent: false,
            terminal: false,
        }
    }

    async fn connect(&mut self, settings: serde_json::Value) -> Result<(), SessionError> {
        if self.runtime.is_some() {
            return Err(SessionError::AlreadyExists("Already connected".to_string()));
        }
        let cfg: VncConfig = serde_json::from_value(settings)
            .map_err(|e| SessionError::InvalidConfig(format!("Invalid VNC settings: {e}")))?;
        if cfg.host.is_empty() {
            return Err(SessionError::InvalidConfig(
                "VNC host is required".to_string(),
            ));
        }

        // Establish transport (direct TCP or SSH tunnel).
        let (stream, tunnel) = tunnel::connect_transport(&cfg).await?;

        // Negotiate RFB, decoding into RGBA so the shared canvas blits directly.
        let password = cfg.password.clone();
        let client = VncConnector::new(stream)
            .set_version(VncVersion::RFB38)
            .set_auth_method(async move { Ok::<_, VncError>(password) })
            .set_pixel_format(PixelFormat::rgba())
            .allow_shared(true);
        let client = encodings_for(&cfg)
            .into_iter()
            .fold(client, |c, enc| c.add_encoding(enc));
        let client = client
            .build()
            .map_err(map_vnc_err)?
            .try_start()
            .await
            .map_err(map_vnc_err)?
            .finish()
            .map_err(map_vnc_err)?;

        let shared = Arc::new(VncShared {
            clipboard: Mutex::new(String::new()),
            ptr_x: AtomicU32::new(0),
            ptr_y: AtomicU32::new(0),
            view_only: cfg.view_only,
            show_remote_cursor: cfg.show_remote_cursor,
        });
        let cancel = CancellationToken::new();
        let (frame_tx, frame_rx) = mpsc::channel(CHANNEL_DEPTH);
        let (cursor_tx, cursor_rx) = mpsc::channel(CHANNEL_DEPTH);

        let task = tokio::spawn(drive(
            client.clone(),
            shared.clone(),
            cancel.clone(),
            frame_tx,
            cursor_tx,
        ));

        self.frame_rx = StdMutex::new(Some(frame_rx));
        self.cursor_rx = StdMutex::new(Some(cursor_rx));
        self.runtime = Some(Arc::new(VncRuntime {
            client,
            shared,
            cancel,
            _tunnel: tunnel,
        }));
        self.task = Some(task);
        Ok(())
    }

    async fn disconnect(&mut self) -> Result<(), SessionError> {
        if let Some(rt) = self.runtime.take() {
            rt.cancel.cancel();
            let _ = rt.client.close().await;
        }
        if let Some(task) = self.task.take() {
            task.abort();
        }
        self.frame_rx = StdMutex::new(None);
        self.cursor_rx = StdMutex::new(None);
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.runtime.is_some()
    }

    fn write(&self, _data: &[u8]) -> Result<(), SessionError> {
        // Graphical session: no terminal byte stream.
        Ok(())
    }

    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), SessionError> {
        // Terminal (cols/rows) resize is meaningless; pixel resize is on the
        // GraphicalBackend trait.
        Ok(())
    }

    fn subscribe_output(&self) -> OutputReceiver {
        let (_tx, rx) = mpsc::channel(1);
        rx
    }

    fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
        None
    }

    fn file_browser(&self) -> Option<&dyn FileBrowser> {
        None
    }

    fn graphical(&self) -> Option<&dyn GraphicalBackend> {
        if self.runtime.is_some() {
            Some(self as &dyn GraphicalBackend)
        } else {
            None
        }
    }
}

#[async_trait::async_trait]
impl GraphicalBackend for Vnc {
    fn graphical_capabilities(&self) -> GraphicalCapabilities {
        GraphicalCapabilities {
            auth_kinds: vec![AuthKind::None, AuthKind::Password],
            // vnc-rs offers no client-initiated SetDesktopSize; the frontend
            // scales the canvas instead.
            supports_dynamic_resize: false,
            supports_clipboard: true,
            view_only_capable: true,
        }
    }

    fn subscribe_frames(&self) -> FrameReceiver {
        if let Ok(mut guard) = self.frame_rx.lock() {
            if let Some(rx) = guard.take() {
                return rx;
            }
        }
        let (_tx, rx) = mpsc::channel(1);
        rx
    }

    fn subscribe_cursor(&self) -> CursorReceiver {
        if let Ok(mut guard) = self.cursor_rx.lock() {
            if let Some(rx) = guard.take() {
                return rx;
            }
        }
        let (_tx, rx) = mpsc::channel(1);
        rx
    }

    async fn send_input(&self, event: InputEvent) -> Result<(), SessionError> {
        let Some(rt) = &self.runtime else {
            return Err(SessionError::NotRunning("vnc not connected".to_string()));
        };
        Self::forward_input(rt, event).await
    }

    async fn resize(&self, _width_px: u16, _height_px: u16) -> Result<(), SessionError> {
        // No client-initiated remote resize; the shared frontend scales.
        if self.runtime.is_none() {
            return Err(SessionError::NotRunning("vnc not connected".to_string()));
        }
        Ok(())
    }

    async fn get_clipboard(&self) -> Option<String> {
        let rt = self.runtime.as_ref()?;
        let text = rt.shared.clipboard.lock().await.clone();
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    }

    async fn set_clipboard(&self, text: String) -> Result<(), SessionError> {
        let Some(rt) = &self.runtime else {
            return Err(SessionError::NotRunning("vnc not connected".to_string()));
        };
        if rt.shared.view_only {
            return Ok(());
        }
        rt.client
            .input(X11Event::CopyText(text))
            .await
            .map_err(map_vnc_err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_and_capabilities() {
        let v = Vnc::new();
        assert_eq!(v.type_id(), "vnc");
        assert_eq!(v.display_name(), "VNC");
        let caps = v.capabilities();
        assert!(caps.graphical);
        assert!(!caps.terminal);
        assert!(!caps.file_browser);
    }

    #[test]
    fn graphical_none_until_connected() {
        assert!(Vnc::new().graphical().is_none());
    }

    #[test]
    fn schema_is_vnc_schema() {
        let schema = Vnc::new().settings_schema();
        let keys: Vec<&str> = schema.groups.iter().map(|g| g.key.as_str()).collect();
        assert_eq!(
            keys,
            vec!["connection", "display", "features", "vnc", "sshTunnel"]
        );
    }

    #[test]
    fn button_mask_remaps_dom_to_rfb() {
        assert_eq!(dom_buttons_to_rfb(0b001), 0b001); // left → button 1
        assert_eq!(dom_buttons_to_rfb(0b010), 0b100); // DOM right → button 3
        assert_eq!(dom_buttons_to_rfb(0b100), 0b010); // DOM middle → button 2
        assert_eq!(dom_buttons_to_rfb(0b111), 0b111); // all three
        assert_eq!(dom_buttons_to_rfb(0), 0);
    }

    #[test]
    fn encodings_include_raw_always() {
        let raw_cfg = VncConfig {
            preferred_encoding: "raw".to_string(),
            ..Default::default()
        };
        let encs = encodings_for(&raw_cfg);
        assert!(encs.contains(&VncEncoding::Raw));
        // Raw preference omits ZRLE.
        assert!(!encs.contains(&VncEncoding::Zrle));

        let zrle_cfg = VncConfig::default();
        let encs = encodings_for(&zrle_cfg);
        assert!(encs.contains(&VncEncoding::Zrle));
        assert!(encs.contains(&VncEncoding::Raw));
        assert!(encs.contains(&VncEncoding::CursorPseudo));
    }

    #[test]
    fn no_cursor_encoding_when_disabled() {
        let cfg = VncConfig {
            show_remote_cursor: false,
            ..Default::default()
        };
        assert!(!encodings_for(&cfg).contains(&VncEncoding::CursorPseudo));
    }

    #[tokio::test]
    async fn connect_requires_host() {
        let mut v = Vnc::new();
        let err = v.connect(serde_json::json!({})).await.unwrap_err();
        assert!(matches!(err, SessionError::InvalidConfig(_)));
    }

    #[tokio::test]
    async fn graphical_methods_error_when_disconnected() {
        let v = Vnc::new();
        assert!(v
            .send_input(InputEvent::Key {
                code: "KeyA".to_string(),
                pressed: true
            })
            .await
            .is_err());
        assert!(v.get_clipboard().await.is_none());
        assert!(v.set_clipboard("x".to_string()).await.is_err());
    }

    #[test]
    fn graphical_capabilities_advertise_password_and_clipboard() {
        let caps = Vnc::new().graphical_capabilities();
        assert!(caps.auth_kinds.contains(&AuthKind::Password));
        assert!(caps.auth_kinds.contains(&AuthKind::None));
        assert!(caps.supports_clipboard);
        assert!(caps.view_only_capable);
        assert!(!caps.supports_dynamic_resize);
    }
}
