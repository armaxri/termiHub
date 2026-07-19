//! The RDP session actor: connect (X.224 → TLS → CredSSP/NLA → capabilities),
//! then decode the graphics pipeline and translate input, streaming everything
//! over the sidecar IPC instead of in-process mpsc channels.
//!
//! Ported near-verbatim from the parked #1682 `core/src/backends/rdp/mod.rs`.
//! The only structural change is the seam the whole sidecar exists to move: the
//! parked actor pushed [`FrameUpdate`]/[`CursorUpdate`] onto tokio channels and
//! pulled [`InputEvent`]s off one; here those become framed
//! [`SidecarMessage`]/[`HostMessage`] reads and writes on stdio (`ipc_out` /
//! `ipc_in`). The IronRDP decode/encode logic is unchanged.
//!
//! IronRDP's `ActiveStage` is `!Sync` and the framed transport is single-owner,
//! so the session stays an actor: one task owns the transport, decoded image and
//! active stage, `select!`-ing between server PDUs and host input events.

use anyhow::{anyhow, Context, Result};
use ironrdp::connector::{
    BitmapConfig, ClientConnector, Config as ConnectorConfig, ConnectionResult, Credentials,
    DesktopSize, ServerName,
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
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tracing::{debug, warn};

use termihub_core::backends::rdp_sidecar::config::{RdpConfig, SecurityMode};
use termihub_core::backends::rdp_sidecar::protocol::{
    read_message, write_message, HostMessage, SidecarMessage,
};
use termihub_core::connection::{
    CursorShape, CursorUpdate, DirtyRect, FrameUpdate, GraphicalState, InputEvent,
};

use crate::input;

/// The framed RDP transport after the TLS upgrade.
type RdpFramed = TokioFramed<ironrdp_tls::TlsStream<TcpStream>>;

/// Client name advertised to the RDP server (shown in some server session logs).
const CLIENT_NAME: &str = "termiHub";

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
fn build_connector_config(cfg: &RdpConfig) -> Result<ConnectorConfig> {
    let (enable_tls, enable_credssp) = security_flags(cfg.security());

    // RDP bitmap output is only defined for 16- or 32-bit color; clamp anything
    // else to 32-bit (the shared editor also offers 8/24 which RDP rejects).
    let color_depth = if cfg.color_depth_bpp() == 16 { 16 } else { 32 };
    let codecs = client_codecs_capabilities(&[])
        .map_err(|help| anyhow!("RDP codec setup failed: {help}"))?;

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

/// Whether an error message reads as an authentication rejection (so the caller
/// can report `AuthFailed` rather than `ConnectFailed`).
pub fn is_auth_error(msg: &str) -> bool {
    let lower = msg.to_ascii_lowercase();
    lower.contains("credssp")
        || lower.contains("logon")
        || lower.contains("authenticat")
        || lower.contains("access denied")
        || lower.contains("access_denied")
}

/// Run the IronRDP connect sequence to an active session: TCP → X.224 → TLS →
/// CredSSP/NLA → capability exchange. Returns the negotiated result and the
/// framed transport for the driver to take over.
async fn connect_session(cfg: &RdpConfig) -> Result<(ConnectionResult, RdpFramed)> {
    let host = cfg.host.clone();
    let port = cfg.effective_port();

    let tcp = TcpStream::connect((host.as_str(), port))
        .await
        .with_context(|| format!("RDP TCP connect to {host}:{port} failed"))?;
    let client_addr = tcp.local_addr().context("RDP local address failed")?;

    let connector_config = build_connector_config(cfg)?;
    let mut connector = ClientConnector::new(connector_config, client_addr);

    // 1) X.224 negotiation up to the security-upgrade point.
    let mut framed = TokioFramed::new(tcp);
    let should_upgrade = ironrdp_tokio::connect_begin(&mut framed, &mut connector)
        .await
        .context("RDP X.224 negotiation failed")?;

    // 2) TLS upgrade. IronRDP's TLS layer accepts the server certificate and
    //    binds trust to the server public key during CredSSP; the interactive
    //    accept-once / accept-for-host prompt is a follow-up.
    let (initial_stream, leftover) = framed.into_inner();
    let (tls_stream, server_cert) = ironrdp_tls::upgrade(initial_stream, host.as_str())
        .await
        .context("RDP TLS upgrade failed")?;
    let server_public_key = ironrdp_tls::extract_tls_server_public_key(&server_cert)
        .ok_or_else(|| anyhow!("could not extract RDP server public key"))?
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
    .context("RDP CredSSP / capability exchange failed")?;

    Ok((result, framed))
}

/// Crop the tightly-packed RGBA pixels of an inclusive rectangle out of the
/// decoded framebuffer, clamped to the image bounds. Returns `None` for an empty
/// or out-of-bounds rect.
fn crop_rect(
    image: &DecodedImage,
    left: u16,
    top: u16,
    right: u16,
    bottom: u16,
) -> Option<DirtyRect> {
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
    Continue,
    Stop,
}

/// Handle the outputs of one `process` / `process_fastpath_input` call: write
/// response frames back on the RDP transport, and emit decoded frames / cursor
/// updates over the sidecar IPC. `cursor` tracks the last pointer position so a
/// cursor-shape update can be positioned.
async fn handle_outputs<T, W>(
    outputs: Vec<ActiveStageOutput>,
    image: &DecodedImage,
    transport: &mut T,
    ipc_out: &mut W,
    cursor: &mut (u32, u32),
) -> Flow
where
    T: FramedWrite,
    W: AsyncWrite + Unpin,
{
    for output in outputs {
        match output {
            ActiveStageOutput::ResponseFrame(bytes) => {
                if transport.write_all(&bytes).await.is_err() {
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
                    if write_message(ipc_out, &SidecarMessage::Frame(update))
                        .await
                        .is_err()
                    {
                        return Flow::Stop;
                    }
                }
            }
            ActiveStageOutput::PointerPosition { x, y } => {
                *cursor = (x as u32, y as u32);
                if emit_cursor(ipc_out, *cursor, true, None).await.is_err() {
                    return Flow::Stop;
                }
            }
            ActiveStageOutput::PointerHidden => {
                if emit_cursor(ipc_out, *cursor, false, None).await.is_err() {
                    return Flow::Stop;
                }
            }
            ActiveStageOutput::PointerDefault => {
                if emit_cursor(ipc_out, *cursor, true, None).await.is_err() {
                    return Flow::Stop;
                }
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
                let visible = shape.is_some();
                if emit_cursor(ipc_out, *cursor, visible, shape).await.is_err() {
                    return Flow::Stop;
                }
            }
            ActiveStageOutput::Terminate(reason) => {
                debug!(%reason, "rdp session terminated by server");
                return Flow::Stop;
            }
            other => {
                debug!(?other, "rdp output ignored");
            }
        }
    }
    Flow::Continue
}

/// Emit a [`CursorUpdate`] over the IPC.
async fn emit_cursor<W>(
    ipc_out: &mut W,
    (x, y): (u32, u32),
    visible: bool,
    shape: Option<CursorShape>,
) -> std::io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    write_message(
        ipc_out,
        &SidecarMessage::Cursor(CursorUpdate {
            x,
            y,
            visible,
            shape,
        }),
    )
    .await
}

/// Encode and send a batch of fast-path input events, writing the resulting
/// response frame(s) on the transport.
async fn send_input_events<T: FramedWrite>(
    stage: &mut ActiveStage,
    image: &mut DecodedImage,
    transport: &mut T,
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
            if transport.write_all(&bytes).await.is_err() {
                return Flow::Stop;
            }
        }
    }
    Flow::Continue
}

/// Connect and run a full RDP session, streaming decoded frames/cursor out over
/// `ipc_out` and applying host input read from `ipc_in`. Emits lifecycle
/// [`SidecarMessage::State`]s at the transitions the host cares about.
pub async fn run_session<R, W>(cfg: RdpConfig, ipc_in: &mut R, ipc_out: &mut W) -> Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    write_message(ipc_out, &SidecarMessage::State(GraphicalState::Authenticating))
        .await
        .context("failed to write state")?;

    let (result, framed) = match connect_session(&cfg).await {
        Ok(v) => v,
        Err(e) => {
            let state = if is_auth_error(&format!("{e:#}")) {
                GraphicalState::AuthFailed
            } else {
                GraphicalState::ConnectFailed
            };
            let _ = write_message(ipc_out, &SidecarMessage::State(state)).await;
            return Err(e);
        }
    };

    write_message(ipc_out, &SidecarMessage::State(GraphicalState::Active))
        .await
        .context("failed to write state")?;

    drive(result, framed, cfg.view_only, ipc_in, ipc_out).await;

    let _ = write_message(ipc_out, &SidecarMessage::State(GraphicalState::ServerClosed)).await;
    Ok(())
}

/// The driver loop: owns the transport, decoded image and active stage;
/// `select!`s between decoding server PDUs and applying host input events.
async fn drive<R, W>(
    result: ConnectionResult,
    framed: RdpFramed,
    view_only: bool,
    ipc_in: &mut R,
    ipc_out: &mut W,
) where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
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
    if write_message(
        ipc_out,
        &SidecarMessage::Frame(FrameUpdate {
            width: size.width as u32,
            height: size.height as u32,
            rects: Vec::new(),
        }),
    )
    .await
    .is_err()
    {
        return;
    }

    let mut prev_buttons: u8 = 0;
    let mut cursor: (u32, u32) = (0, 0);

    loop {
        tokio::select! {
            biased;
            host = read_message::<_, HostMessage>(ipc_in) => {
                let msg = match host {
                    Ok(m) => m,
                    Err(_) => break, // host closed stdin
                };
                match msg {
                    HostMessage::Input(event) => {
                        if view_only {
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
                        if let Flow::Stop =
                            send_input_events(&mut stage, &mut image, &mut writer, &events).await
                        {
                            break;
                        }
                    }
                    HostMessage::Disconnect => break,
                    // Dynamic resize / clipboard are follow-ups; a duplicate
                    // Connect is ignored. All logged and skipped.
                    other => debug!(?other, "rdp sidecar ignored host message"),
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
                    handle_outputs(outputs, &image, &mut writer, ipc_out, &mut cursor).await
                {
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(conn.domain.is_none());
    }

    #[test]
    fn crop_rect_extracts_region() {
        let image = DecodedImage::new(PixelFormat::RgbA32, 4, 4);
        let rect = crop_rect(&image, 0, 0, 1, 1).unwrap();
        assert_eq!(rect.width, 2);
        assert_eq!(rect.height, 2);
        assert!(rect.is_well_formed());
        assert!(crop_rect(&image, 10, 10, 12, 12).is_none());
        assert!(crop_rect(&image, 2, 2, 1, 1).is_none());
    }

    #[test]
    fn crop_rect_clamps_to_bounds() {
        let image = DecodedImage::new(PixelFormat::RgbA32, 4, 4);
        let rect = crop_rect(&image, 2, 2, 100, 100).unwrap();
        assert_eq!((rect.x, rect.y, rect.width, rect.height), (2, 2, 2, 2));
        assert!(rect.is_well_formed());
    }
}
