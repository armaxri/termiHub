//! RDP (Remote Desktop Protocol) graphical remote-desktop backend.
//!
//! Implements the protocol-agnostic [`GraphicalBackend`] trait (#1680) over RDP
//! using the pure-Rust [IronRDP] library. Decode happens here, in Rust: the
//! backend drives IronRDP's connect state machine (X.224 negotiation → TLS →
//! CredSSP/NLA → capability exchange), then runs an active session that decodes
//! the RDP graphics pipeline into the shared [`FrameUpdate`] / [`CursorUpdate`]
//! stream and translates shared [`InputEvent`]s into RDP fast-path input PDUs
//! (scancodes, pointer, wheel). Everything the user touches — canvas, toolbar,
//! overlays, input, scaling — belongs to the shared layer and is untouched here;
//! this module is the wire adapter only.
//!
//! It drops in beside the mock (#1680) and the VNC backend (#1681) under the
//! same trait: a new `backends/rdp/` module, a schema, and one additive registry
//! `register(...)` call — no shared match arm, no editor switch.
//!
//! ## Concurrency
//!
//! IronRDP's `ActiveStage` is `!Sync` and the framed transport is single-owner,
//! so the session runs as an **actor**: one driver task owns the transport,
//! decoded image and active stage, `select!`-ing between server PDUs and shared
//! input events delivered over a channel. The `GraphicalBackend` command methods
//! (`send_input`) only push onto that channel, never touching the stage directly.
//!
//! ## v1 scope
//!
//! Graphics + keyboard/pointer/wheel input + server cursor are wired. Security is
//! **TLS-always** (Auto/NLA use CredSSP; TLS/legacy select TLS without NLA);
//! pure no-TLS legacy RC4, the interactive certificate-trust prompt, CLIPRDR
//! clipboard, Display-Control dynamic resize, drive redirection and audio are
//! tracked as follow-ups (see the PR).
//!
//! [IronRDP]: https://github.com/Devolutions/IronRDP

mod config;
mod input;
mod keymap;

pub use config::rdp_settings_schema;

use std::sync::{Arc, Mutex as StdMutex};

use ironrdp::connector::{
    BitmapConfig, ClientConnector, Config as ConnectorConfig, ConnectionResult, ConnectorError,
    Credentials, DesktopSize, ServerName,
};
use ironrdp::graphics::image_processing::PixelFormat;
use ironrdp::pdu::gcc::KeyboardType;
use ironrdp::pdu::input::fast_path::FastPathInputEvent;
use ironrdp::pdu::rdp::capability_sets::{client_codecs_capabilities, MajorPlatformType};
use ironrdp::pdu::rdp::client_info::{PerformanceFlags, TimezoneInfo};
use ironrdp::session::image::DecodedImage;
use ironrdp::session::{ActiveStage, ActiveStageBuilder, ActiveStageOutput};
use ironrdp_tokio::reqwest::ReqwestNetworkClient;
use ironrdp_tokio::{FramedWrite, TokioFramed};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use crate::connection::{
    AuthKind, Capabilities, ConnectionType, CursorReceiver, CursorShape, CursorUpdate, DirtyRect,
    FrameReceiver, FrameUpdate, GraphicalBackend, GraphicalCapabilities, InputEvent,
    OutputReceiver, SettingsSchema,
};
use crate::errors::SessionError;
use crate::files::FileBrowser;
use crate::monitoring::MonitoringProvider;

use config::{RdpConfig, SecurityMode};

/// The framed RDP transport after the TLS upgrade.
type RdpFramed = TokioFramed<ironrdp_tls::TlsStream<TcpStream>>;

/// Bounded channel depth for frames / cursor updates / input (backpressure).
const CHANNEL_DEPTH: usize = 32;

/// Client name advertised to the RDP server (shown in some server session logs).
const CLIENT_NAME: &str = "termiHub";

/// Shared, interior-mutable state touched by the driver task and the
/// `GraphicalBackend` command methods.
struct RdpShared {
    /// Suppress input when the session is view-only.
    view_only: bool,
}

/// Live runtime of a connected RDP session.
struct RdpRuntime {
    /// Input events flow to the driver task over this channel.
    input_tx: mpsc::Sender<InputEvent>,
    shared: Arc<RdpShared>,
    cancel: CancellationToken,
}

/// RDP graphical remote-desktop connection.
pub struct Rdp {
    runtime: Option<Arc<RdpRuntime>>,
    frame_rx: StdMutex<Option<FrameReceiver>>,
    cursor_rx: StdMutex<Option<CursorReceiver>>,
    task: Option<JoinHandle<()>>,
}

impl Rdp {
    /// Create a new, disconnected RDP backend.
    pub fn new() -> Self {
        Self {
            runtime: None,
            frame_rx: StdMutex::new(None),
            cursor_rx: StdMutex::new(None),
            task: None,
        }
    }
}

impl Default for Rdp {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for Rdp {
    fn drop(&mut self) {
        if let Some(rt) = &self.runtime {
            rt.cancel.cancel();
        }
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

/// Map a security mode to IronRDP's `(enable_tls, enable_credssp)` pair.
///
/// TLS is always on (secure by default): Auto/NLA use CredSSP; TLS and the
/// "legacy" option select TLS without CredSSP. Pure no-TLS RC4 is not supported
/// by IronRDP's high-level connect flow and is a documented follow-up.
fn security_flags(mode: SecurityMode) -> (bool, bool) {
    match mode {
        SecurityMode::Auto | SecurityMode::Nla => (true, true),
        SecurityMode::Tls | SecurityMode::Rdp => (true, false),
    }
}

/// Build IronRDP's connector [`Config`](ConnectorConfig) from our settings.
///
/// The `connector::Config` has no `Default`, so every field is populated here,
/// mirroring the IronRDP reference client's initializer.
fn build_connector_config(cfg: &RdpConfig) -> Result<ConnectorConfig, SessionError> {
    let (enable_tls, enable_credssp) = security_flags(cfg.security());

    // RDP bitmap output is only defined for 16- or 32-bit color; clamp anything
    // else to 32-bit (the shared editor also offers 8/24 which RDP rejects).
    let color_depth = if cfg.color_depth_bpp() == 16 { 16 } else { 32 };
    let codecs = client_codecs_capabilities(&[])
        .map_err(|help| SessionError::InvalidConfig(format!("RDP codec setup failed: {help}")))?;

    Ok(ConnectorConfig {
        credentials: Credentials::UsernamePassword {
            username: cfg.username.clone(),
            password: cfg.password.clone(),
        },
        domain: (!cfg.domain.is_empty()).then(|| cfg.domain.clone()),
        enable_tls,
        enable_credssp,
        keyboard_type: KeyboardType::IbmEnhanced,
        keyboard_subtype: 0,
        keyboard_layout: 0,
        keyboard_functional_keys_count: 12,
        ime_file_name: String::new(),
        dig_product_id: String::new(),
        desktop_size: DesktopSize {
            width: cfg.desktop_width(),
            height: cfg.desktop_height(),
        },
        desktop_scale_factor: 0,
        bitmap: Some(BitmapConfig {
            color_depth,
            lossy_compression: true,
            codecs,
        }),
        client_build: 0,
        client_name: CLIENT_NAME.to_string(),
        client_dir: String::new(),
        platform: MajorPlatformType::UNSPECIFIED,
        hardware_id: None,
        license_cache: None,
        enable_server_pointer: true,
        autologon: false,
        enable_audio_playback: false,
        request_data: None,
        pointer_software_rendering: false,
        multitransport_flags: None,
        compression_type: None,
        performance_flags: PerformanceFlags::default(),
        timezone_info: TimezoneInfo::default(),
        alternate_shell: String::new(),
        work_dir: String::new(),
    })
}

/// Map an IronRDP connector error to a [`SessionError`], flagging authentication
/// rejection so the message is actionable.
fn map_connector_err(e: ConnectorError) -> SessionError {
    let msg = e.to_string();
    let lower = msg.to_ascii_lowercase();
    if lower.contains("credssp")
        || lower.contains("logon")
        || lower.contains("authenticat")
        || lower.contains("access denied")
        || lower.contains("access_denied")
    {
        SessionError::SpawnFailed(format!("RDP authentication failed: {msg}"))
    } else {
        SessionError::SpawnFailed(format!("RDP connection failed: {msg}"))
    }
}

/// Run the IronRDP connect sequence to an active session: TCP → X.224 → TLS →
/// CredSSP/NLA → capability exchange. Returns the negotiated result and the
/// framed transport for the driver to take over.
async fn connect_session(cfg: &RdpConfig) -> Result<(ConnectionResult, RdpFramed), SessionError> {
    let host = cfg.host.clone();
    let port = cfg.effective_port();

    let tcp = TcpStream::connect((host.as_str(), port))
        .await
        .map_err(|e| SessionError::SpawnFailed(format!("RDP connect failed: {e}")))?;
    let client_addr = tcp
        .local_addr()
        .map_err(|e| SessionError::SpawnFailed(format!("RDP local address failed: {e}")))?;

    let connector_config = build_connector_config(cfg)?;
    let mut connector = ClientConnector::new(connector_config, client_addr);

    // 1) X.224 negotiation up to the security-upgrade point.
    let mut framed = TokioFramed::new(tcp);
    let should_upgrade = ironrdp_tokio::connect_begin(&mut framed, &mut connector)
        .await
        .map_err(map_connector_err)?;

    // 2) TLS upgrade. IronRDP's TLS layer accepts the server certificate and
    //    binds trust to the server public key during CredSSP; the interactive
    //    accept-once / accept-for-host prompt is a follow-up.
    let (initial_stream, leftover) = framed.into_inner();
    let (tls_stream, server_cert) = ironrdp_tls::upgrade(initial_stream, host.as_str())
        .await
        .map_err(|e| SessionError::SpawnFailed(format!("RDP TLS upgrade failed: {e}")))?;
    let server_public_key = ironrdp_tls::extract_tls_server_public_key(&server_cert)
        .ok_or_else(|| {
            SessionError::SpawnFailed("could not extract RDP server public key".to_string())
        })?
        .to_vec();

    let upgraded = ironrdp_tokio::mark_as_upgraded(should_upgrade, &mut connector);
    let mut framed = TokioFramed::new_with_leftover(tls_stream, leftover);

    // 3) CredSSP/NLA + channel join + capability exchange.
    let mut network_client = ReqwestNetworkClient::new();
    let result = ironrdp_tokio::connect_finalize(
        upgraded,
        connector,
        &mut framed,
        &mut network_client,
        ServerName::new(host),
        server_public_key,
        None,
    )
    .await
    .map_err(map_connector_err)?;

    Ok((result, framed))
}

/// Crop the tightly-packed RGBA pixels of an inclusive rectangle out of the
/// decoded framebuffer, clamped to the image bounds. Returns `None` for an empty
/// or out-of-bounds rect.
fn crop_rect(image: &DecodedImage, left: u16, top: u16, right: u16, bottom: u16) -> Option<DirtyRect> {
    let (img_w, img_h) = (image.width(), image.height());
    if left > right || top > bottom || left >= img_w || top >= img_h {
        return None;
    }
    let right = right.min(img_w - 1);
    let bottom = bottom.min(img_h - 1);
    let (x, y) = (left as usize, top as usize);
    let w = (right - left + 1) as usize;
    let h = (bottom - top + 1) as usize;
    let stride = image.stride();
    let data = image.data();
    let mut rgba = Vec::with_capacity(w * h * 4);
    for row in 0..h {
        let off = (y + row) * stride + x * 4;
        rgba.extend_from_slice(&data[off..off + w * 4]);
    }
    Some(DirtyRect {
        x: left as u32,
        y: top as u32,
        width: w as u32,
        height: h as u32,
        data: rgba,
    })
}

/// Outcome of processing a batch of [`ActiveStageOutput`]s.
enum Flow {
    /// The session continues.
    Continue,
    /// The session should end (server terminated or a channel closed).
    Stop,
}

/// Handle the outputs of one `process` / `process_fastpath_input` call: write
/// response frames, emit decoded frames and cursor updates. `cursor` tracks the
/// last known pointer position so a cursor-shape update can be positioned.
async fn handle_outputs(
    outputs: Vec<ActiveStageOutput>,
    image: &DecodedImage,
    writer: &mut RdpFramed,
    frame_tx: &mpsc::Sender<FrameUpdate>,
    cursor_tx: &mpsc::Sender<CursorUpdate>,
    cursor: &mut (u32, u32),
) -> Flow {
    for output in outputs {
        match output {
            ActiveStageOutput::ResponseFrame(bytes) => {
                if writer.write_all(&bytes).await.is_err() {
                    return Flow::Stop;
                }
            }
            ActiveStageOutput::GraphicsUpdate(rect) => {
                if let Some(dirty) = crop_rect(image, rect.left, rect.top, rect.right, rect.bottom) {
                    let update = FrameUpdate {
                        width: image.width() as u32,
                        height: image.height() as u32,
                        rects: vec![dirty],
                    };
                    if frame_tx.send(update).await.is_err() {
                        return Flow::Stop;
                    }
                }
            }
            ActiveStageOutput::PointerPosition { x, y } => {
                *cursor = (x as u32, y as u32);
                let _ = cursor_tx
                    .send(CursorUpdate {
                        x: x as u32,
                        y: y as u32,
                        visible: true,
                        shape: None,
                    })
                    .await;
            }
            ActiveStageOutput::PointerHidden => {
                let _ = cursor_tx
                    .send(CursorUpdate {
                        x: cursor.0,
                        y: cursor.1,
                        visible: false,
                        shape: None,
                    })
                    .await;
            }
            ActiveStageOutput::PointerDefault => {
                let _ = cursor_tx
                    .send(CursorUpdate {
                        x: cursor.0,
                        y: cursor.1,
                        visible: true,
                        shape: None,
                    })
                    .await;
            }
            ActiveStageOutput::PointerBitmap(pointer) => {
                let (w, h) = (pointer.width as u32, pointer.height as u32);
                let shape = (w != 0
                    && h != 0
                    && pointer.bitmap_data.len() == (w as usize) * (h as usize) * 4)
                .then(|| CursorShape {
                    width: w,
                    height: h,
                    hotspot_x: pointer.hotspot_x as u32,
                    hotspot_y: pointer.hotspot_y as u32,
                    data: pointer.bitmap_data.clone(),
                });
                let _ = cursor_tx
                    .send(CursorUpdate {
                        x: cursor.0,
                        y: cursor.1,
                        visible: shape.is_some(),
                        shape,
                    })
                    .await;
            }
            ActiveStageOutput::Terminate(reason) => {
                debug!(%reason, "rdp session terminated by server");
                return Flow::Stop;
            }
            // DeactivateAll would begin a deactivation-reactivation sequence
            // (used on server-side resolution changes); v1 keeps a fixed
            // resolution, so it is logged and ignored. AutoDetect /
            // MultitransportRequest have no shared surface to route to.
            other => {
                debug!(?other, "rdp output ignored");
            }
        }
    }
    Flow::Continue
}

/// Encode and send a batch of fast-path input events, writing the resulting
/// response frame(s) on the transport.
async fn send_input_events(
    stage: &mut ActiveStage,
    image: &mut DecodedImage,
    writer: &mut RdpFramed,
    events: &[FastPathInputEvent],
) -> Flow {
    let outputs = match stage.process_fastpath_input(image, events) {
        Ok(o) => o,
        Err(e) => {
            warn!(error = %e, "rdp input encode failed");
            return Flow::Stop;
        }
    };
    for output in outputs {
        if let ActiveStageOutput::ResponseFrame(bytes) = output {
            if writer.write_all(&bytes).await.is_err() {
                return Flow::Stop;
            }
        }
    }
    Flow::Continue
}

/// The driver task: owns the transport, decoded image and active stage;
/// `select!`s between decoding server PDUs and encoding shared input events.
async fn drive(
    result: ConnectionResult,
    framed: RdpFramed,
    shared: Arc<RdpShared>,
    cancel: CancellationToken,
    frame_tx: mpsc::Sender<FrameUpdate>,
    cursor_tx: mpsc::Sender<CursorUpdate>,
    mut input_rx: mpsc::Receiver<InputEvent>,
) {
    let size = result.desktop_size;
    let mut image = DecodedImage::new(PixelFormat::RgbA32, size.width, size.height);
    let mut stage = ActiveStageBuilder {
        static_channels: result.static_channels,
        user_channel_id: result.user_channel_id,
        io_channel_id: result.io_channel_id,
        message_channel_id: result.message_channel_id,
        share_id: result.share_id,
        compression_type: result.compression_type,
        enable_server_pointer: result.enable_server_pointer,
        pointer_software_rendering: result.pointer_software_rendering,
    }
    .build();

    // Split the transport so reads live in the `select!` while writes happen in
    // the handlers, avoiding a double mutable borrow of the framed stream.
    let (mut reader, mut writer) = ironrdp_tokio::split_tokio_framed(framed);

    // Size the shared canvas up front; the server paints on the first update.
    let _ = frame_tx
        .send(FrameUpdate {
            width: size.width as u32,
            height: size.height as u32,
            rects: Vec::new(),
        })
        .await;

    let mut prev_buttons: u8 = 0;
    let mut cursor: (u32, u32) = (0, 0);

    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => break,
            maybe_event = input_rx.recv() => {
                let Some(event) = maybe_event else { break };
                if shared.view_only {
                    continue;
                }
                if let InputEvent::Pointer { x, y, .. } = &event {
                    cursor = (*x, *y);
                }
                let events = input::translate(prev_buttons, &event);
                if let InputEvent::Pointer { buttons, .. } = &event {
                    prev_buttons = *buttons;
                }
                if events.is_empty() {
                    continue;
                }
                if let Flow::Stop = send_input_events(&mut stage, &mut image, &mut writer, &events).await {
                    break;
                }
            }
            read = reader.read_pdu() => {
                let (action, payload) = match read {
                    Ok(v) => v,
                    Err(e) => {
                        debug!(error = %e, "rdp transport closed");
                        break;
                    }
                };
                let outputs = match stage.process(&mut image, action, &payload) {
                    Ok(o) => o,
                    Err(e) => {
                        warn!(error = %e, "rdp process error");
                        break;
                    }
                };
                if let Flow::Stop =
                    handle_outputs(outputs, &image, &mut writer, &frame_tx, &cursor_tx, &mut cursor).await
                {
                    break;
                }
            }
        }
    }
}

#[async_trait::async_trait]
impl ConnectionType for Rdp {
    fn type_id(&self) -> &str {
        "rdp"
    }

    fn display_name(&self) -> &str {
        "RDP"
    }

    fn settings_schema(&self) -> SettingsSchema {
        rdp_settings_schema()
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
        let cfg: RdpConfig = serde_json::from_value(settings)
            .map_err(|e| SessionError::InvalidConfig(format!("Invalid RDP settings: {e}")))?;
        if cfg.host.is_empty() {
            return Err(SessionError::InvalidConfig(
                "RDP host is required".to_string(),
            ));
        }

        let (result, framed) = connect_session(&cfg).await?;

        let shared = Arc::new(RdpShared {
            view_only: cfg.view_only,
        });
        let cancel = CancellationToken::new();
        let (frame_tx, frame_rx) = mpsc::channel(CHANNEL_DEPTH);
        let (cursor_tx, cursor_rx) = mpsc::channel(CHANNEL_DEPTH);
        let (input_tx, input_rx) = mpsc::channel(CHANNEL_DEPTH);

        let task = tokio::spawn(drive(
            result,
            framed,
            shared.clone(),
            cancel.clone(),
            frame_tx,
            cursor_tx,
            input_rx,
        ));

        self.frame_rx = StdMutex::new(Some(frame_rx));
        self.cursor_rx = StdMutex::new(Some(cursor_rx));
        self.runtime = Some(Arc::new(RdpRuntime {
            input_tx,
            shared,
            cancel,
        }));
        self.task = Some(task);
        Ok(())
    }

    async fn disconnect(&mut self) -> Result<(), SessionError> {
        if let Some(rt) = self.runtime.take() {
            rt.cancel.cancel();
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
impl GraphicalBackend for Rdp {
    fn graphical_capabilities(&self) -> GraphicalCapabilities {
        GraphicalCapabilities {
            // RDP authenticates with username+password, negotiating NLA (CredSSP)
            // when available.
            auth_kinds: vec![AuthKind::UsernamePassword, AuthKind::Nla],
            // Display-Control dynamic resize is a follow-up; the frontend scales
            // the canvas meanwhile.
            supports_dynamic_resize: false,
            // CLIPRDR clipboard bridging is a follow-up.
            supports_clipboard: false,
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
            return Err(SessionError::NotRunning("rdp not connected".to_string()));
        };
        if rt.shared.view_only {
            return Ok(());
        }
        rt.input_tx
            .send(event)
            .await
            .map_err(|_| SessionError::NotRunning("rdp session ended".to_string()))
    }

    async fn resize(&self, _width_px: u16, _height_px: u16) -> Result<(), SessionError> {
        // Display-Control dynamic resize is a follow-up; the shared frontend
        // scales the canvas at the negotiated resolution.
        if self.runtime.is_none() {
            return Err(SessionError::NotRunning("rdp not connected".to_string()));
        }
        Ok(())
    }

    async fn get_clipboard(&self) -> Option<String> {
        // CLIPRDR clipboard bridging is a follow-up.
        None
    }

    async fn set_clipboard(&self, _text: String) -> Result<(), SessionError> {
        // CLIPRDR clipboard bridging is a follow-up.
        if self.runtime.is_none() {
            return Err(SessionError::NotRunning("rdp not connected".to_string()));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_and_capabilities() {
        let r = Rdp::new();
        assert_eq!(r.type_id(), "rdp");
        assert_eq!(r.display_name(), "RDP");
        let caps = r.capabilities();
        assert!(caps.graphical);
        assert!(!caps.terminal);
        assert!(!caps.file_browser);
    }

    #[test]
    fn graphical_none_until_connected() {
        assert!(Rdp::new().graphical().is_none());
    }

    #[test]
    fn schema_is_rdp_schema() {
        let schema = Rdp::new().settings_schema();
        let keys: Vec<&str> = schema.groups.iter().map(|g| g.key.as_str()).collect();
        assert_eq!(keys, vec!["connection", "display", "features", "rdp"]);
    }

    #[test]
    fn security_flags_map_modes() {
        assert_eq!(security_flags(SecurityMode::Auto), (true, true));
        assert_eq!(security_flags(SecurityMode::Nla), (true, true));
        assert_eq!(security_flags(SecurityMode::Tls), (true, false));
        assert_eq!(security_flags(SecurityMode::Rdp), (true, false));
    }

    #[test]
    fn connector_config_reflects_settings() {
        let cfg = RdpConfig {
            host: "h".to_string(),
            username: "user".to_string(),
            password: "pw".to_string(),
            domain: "CORP".to_string(),
            security_mode: "nla".to_string(),
            color_depth: "16".to_string(),
            width: Some(1024),
            height: Some(768),
            ..Default::default()
        };
        let conn = build_connector_config(&cfg).unwrap();
        assert!(conn.enable_tls);
        assert!(conn.enable_credssp);
        assert_eq!(conn.domain.as_deref(), Some("CORP"));
        assert_eq!(conn.desktop_size.width, 1024);
        assert_eq!(conn.desktop_size.height, 768);
        assert_eq!(conn.bitmap.as_ref().unwrap().color_depth, 16);
        assert!(matches!(
            conn.credentials,
            Credentials::UsernamePassword { .. }
        ));
    }

    #[test]
    fn connector_config_defaults_color_depth_to_32() {
        let cfg = RdpConfig {
            host: "h".to_string(),
            color_depth: "8".to_string(),
            ..Default::default()
        };
        let conn = build_connector_config(&cfg).unwrap();
        assert_eq!(conn.bitmap.as_ref().unwrap().color_depth, 32);
        // Empty domain becomes None.
        assert!(conn.domain.is_none());
    }

    #[test]
    fn crop_rect_extracts_region() {
        let mut image = DecodedImage::new(PixelFormat::RgbA32, 4, 4);
        // DecodedImage starts zeroed; crop a 2x2 inclusive rect (0,0)-(1,1).
        let rect = crop_rect(&image, 0, 0, 1, 1).unwrap();
        assert_eq!(rect.width, 2);
        assert_eq!(rect.height, 2);
        assert!(rect.is_well_formed());
        // Out-of-bounds origin yields None.
        assert!(crop_rect(&image, 10, 10, 12, 12).is_none());
        // Inverted rect yields None.
        assert!(crop_rect(&image, 2, 2, 1, 1).is_none());
        let _ = &mut image;
    }

    #[test]
    fn crop_rect_clamps_to_bounds() {
        let image = DecodedImage::new(PixelFormat::RgbA32, 4, 4);
        // Right/bottom beyond the image are clamped to the last pixel.
        let rect = crop_rect(&image, 2, 2, 100, 100).unwrap();
        assert_eq!(rect.x, 2);
        assert_eq!(rect.y, 2);
        assert_eq!(rect.width, 2);
        assert_eq!(rect.height, 2);
        assert!(rect.is_well_formed());
    }

    #[tokio::test]
    async fn connect_requires_host() {
        let mut r = Rdp::new();
        let err = r.connect(serde_json::json!({})).await.unwrap_err();
        assert!(matches!(err, SessionError::InvalidConfig(_)));
    }

    #[tokio::test]
    async fn graphical_methods_error_when_disconnected() {
        let r = Rdp::new();
        assert!(r
            .send_input(InputEvent::Key {
                code: "KeyA".to_string(),
                pressed: true,
            })
            .await
            .is_err());
        assert!(r.get_clipboard().await.is_none());
        assert!(r.set_clipboard("x".to_string()).await.is_err());
        assert!(r.resize(800, 600).await.is_err());
    }

    #[test]
    fn graphical_capabilities_advertise_username_password_and_nla() {
        let caps = Rdp::new().graphical_capabilities();
        assert!(caps.auth_kinds.contains(&AuthKind::UsernamePassword));
        assert!(caps.auth_kinds.contains(&AuthKind::Nla));
        assert!(caps.view_only_capable);
        // Dynamic resize and clipboard are follow-ups.
        assert!(!caps.supports_dynamic_resize);
        assert!(!caps.supports_clipboard);
    }
}
