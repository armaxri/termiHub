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
use ironrdp::cliprdr::{Client as CliprdrRole, CliprdrClient, CliprdrSvcMessages};
use ironrdp::connector::connection_activation::{
    ConnectionActivationSequence, ConnectionActivationState,
};
use ironrdp::connector::{
    BitmapConfig, ClientConnector, Config as ConnectorConfig, ConnectionResult, Credentials,
    DesktopSize, ServerName,
};
use ironrdp::core::WriteBuf;
use ironrdp::displaycontrol::client::DisplayControlClient;
use ironrdp::displaycontrol::pdu::MonitorLayoutEntry;
use ironrdp::dvc::DrdynvcClient;
use ironrdp::graphics::image_processing::PixelFormat;
use ironrdp::pdu::gcc::KeyboardType;
use ironrdp::rdpdr::Rdpdr;
use ironrdp::rdpsnd::client::{NoopRdpsndBackend, Rdpsnd};
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

use crate::clipboard::{
    build_format_data_response, local_text_formats, ClipboardEvent, SidecarClipboardBackend,
};
use crate::drive::DriveRedirectBackend;
use crate::input;

/// The RDPDR device id used for the single redirected drive (#1757). Any
/// non-zero id works; IRPs the server sends carry it, and IronRDP routes them to
/// our backend.
const DRIVE_DEVICE_ID: u32 = 1;

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
/// CredSSP/NLA → capability exchange. Returns the negotiated result, the framed
/// transport for the driver to take over, the connector [`Config`] (needed
/// verbatim to drive the Deactivation-Reactivation Sequence on dynamic resize,
/// #1755), and the receiver on which the registered CLIPRDR backend surfaces
/// clipboard events for the driver (#1756).
async fn connect_session(
    cfg: &RdpConfig,
) -> Result<(
    ConnectionResult,
    RdpFramed,
    ConnectorConfig,
    std::sync::mpsc::Receiver<ClipboardEvent>,
)> {
    let host = cfg.host.clone();
    let port = cfg.effective_port();

    let tcp = TcpStream::connect((host.as_str(), port))
        .await
        .with_context(|| format!("RDP TCP connect to {host}:{port} failed"))?;
    let client_addr = tcp.local_addr().context("RDP local address failed")?;

    let connector_config = build_connector_config(cfg)?;
    // Register the CLIPRDR static channel (MS-RDPECLIP) so the session can bridge
    // text clipboard both ways (#1756). The backend translates server callbacks
    // into `ClipboardEvent`s the driver drains once it owns the active stage
    // again; the receiver rides back out with the connection result.
    let (clipboard_backend, clipboard_rx) = SidecarClipboardBackend::new();
    // Register the Display Control Virtual Channel (MS-RDPEDISP) so the session
    // can request dynamic resolution changes (#1755). It rides the drdynvc
    // static channel; the capabilities callback needs to send nothing, the
    // channel just has to be ready before we encode a resize.
    let mut connector = ClientConnector::new(connector_config.clone(), client_addr)
        .with_static_channel(CliprdrClient::new(Box::new(clipboard_backend)))
        .with_static_channel(
            DrdynvcClient::new()
                .with_dynamic_channel(DisplayControlClient::new(|_caps| Ok(Vec::new()))),
        );

    // Drive redirection (MS-RDPEFS) is opt-in per connection and serves exactly
    // the one folder the user selected (#1757). MS-RDPEFS requires the `rdpsnd`
    // channel to be co-advertised for the server to talk back to `rdpdr`, so we
    // register a no-op `rdpsnd` handler alongside it (audio playback itself is a
    // sequenced follow-up). When redirection is off, neither channel is
    // registered and nothing on the local filesystem is exposed.
    if let Some(root) = cfg.shared_drive_root() {
        debug!(root = %root.display(), "registering rdpdr drive redirection");
        let backend = DriveRedirectBackend::new(root);
        connector = connector
            .with_static_channel(Rdpsnd::new(Box::new(NoopRdpsndBackend)))
            .with_static_channel(
                Rdpdr::new(Box::new(backend), CLIENT_NAME.to_string())
                    .with_drives(Some(vec![(DRIVE_DEVICE_ID, cfg.drive_label())])),
            );
    }

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

    Ok((result, framed, connector_config, clipboard_rx))
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
    /// The server sent a Deactivate All PDU (typically after a Display Control
    /// resize): the driver must run the Deactivation-Reactivation Sequence.
    Reactivate,
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
                if let Some(dirty) = crop_rect(image, rect.left, rect.top, rect.right, rect.bottom)
                {
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
            ActiveStageOutput::DeactivateAll => {
                // The server tears the capability set down and rebuilds it — the
                // mechanism by which a Display Control resize takes effect. The
                // driver owns both transport halves, so it runs the sequence.
                debug!("rdp server sent deactivate-all; reactivating");
                return Flow::Reactivate;
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
    write_message(
        ipc_out,
        &SidecarMessage::State(GraphicalState::Authenticating),
    )
    .await
    .context("failed to write state")?;

    let (result, framed, connector_config, clipboard_rx) = match connect_session(&cfg).await {
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

    drive(
        result,
        framed,
        connector_config,
        clipboard_rx,
        cfg.view_only,
        ipc_in,
        ipc_out,
    )
    .await;

    let _ = write_message(
        ipc_out,
        &SidecarMessage::State(GraphicalState::ServerClosed),
    )
    .await;
    Ok(())
}

/// The driver loop: owns the transport, decoded image and active stage;
/// `select!`s between decoding server PDUs and applying host input events.
async fn drive<R, W>(
    result: ConnectionResult,
    framed: RdpFramed,
    connector_config: ConnectorConfig,
    clipboard_rx: std::sync::mpsc::Receiver<ClipboardEvent>,
    view_only: bool,
    ipc_in: &mut R,
    ipc_out: &mut W,
) where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let size = result.desktop_size;
    // The MCS channel IDs are negotiated once and stay invariant across a
    // Deactivation-Reactivation Sequence, so they seed a fresh reactivation.
    let io_channel_id = result.io_channel_id;
    let user_channel_id = result.user_channel_id;
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
    // The latest host clipboard text pushed via `SetClipboard`, served back to the
    // server when it requests our clipboard data (#1756). `None` until the host
    // copies something.
    let mut local_clipboard: Option<String> = None;

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
                    HostMessage::Resize { width, height } => {
                        // Ask the server for a new resolution over the Display
                        // Control channel (#1755). The server applies it via a
                        // Deactivation-Reactivation Sequence, handled below.
                        // Dimensions must be clamped to the MS-RDPEDISP range
                        // (200..=8192, even width) before encoding.
                        let (w, h) = MonitorLayoutEntry::adjust_display_size(
                            u32::from(width),
                            u32::from(height),
                        );
                        match stage.encode_resize(w, h, None, None) {
                            Some(Ok(frame)) => {
                                if writer.write_all(&frame).await.is_err() {
                                    break;
                                }
                                debug!(width = w, height = h, "requested display-control resize");
                            }
                            Some(Err(e)) => {
                                warn!(error = %e, "failed to encode display-control resize")
                            }
                            None => debug!(
                                "display control channel not ready; resize request dropped"
                            ),
                        }
                    }
                    HostMessage::SetClipboard(text) => {
                        // The host copied text locally; mirror it to the remote
                        // over CLIPRDR (#1756). View-only sessions never push the
                        // local clipboard to the server.
                        if view_only {
                            continue;
                        }
                        local_clipboard = Some(text);
                        if advertise_local_clipboard(
                            &mut stage,
                            &mut writer,
                            local_clipboard.as_deref(),
                        )
                        .await
                        .is_err()
                        {
                            break;
                        }
                    }
                    HostMessage::Disconnect => break,
                    // A duplicate Connect is ignored.
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
                // Processing the PDU may have run CLIPRDR backend callbacks, which
                // queue clipboard actions. Now that the active stage is ours again,
                // drain them (#1756) before handling the graphics outputs.
                if drain_clipboard_events(
                    &clipboard_rx,
                    &mut stage,
                    &mut writer,
                    ipc_out,
                    local_clipboard.as_deref(),
                )
                .await
                .is_err()
                {
                    break;
                }
                match handle_outputs(outputs, &image, &mut writer, ipc_out, &mut cursor).await {
                    Flow::Continue => {}
                    Flow::Stop => break,
                    Flow::Reactivate => {
                        // Reunite the split halves — the reactivation sequence is a
                        // synchronous request/response that owns the whole transport
                        // — run it, then re-split for the concurrent read/write loop.
                        let framed = ironrdp_tokio::unsplit_tokio_framed(reader, writer);
                        match reactivate(
                            framed,
                            connector_config.clone(),
                            &mut stage,
                            &mut image,
                            io_channel_id,
                            user_channel_id,
                        )
                        .await
                        {
                            Ok(new_framed) => {
                                let (r, w) = ironrdp_tokio::split_tokio_framed(new_framed);
                                reader = r;
                                writer = w;
                                // The canvas is now a different size; tell the host so
                                // it can resize before the server repaints.
                                if write_message(
                                    ipc_out,
                                    &SidecarMessage::Frame(FrameUpdate {
                                        width: image.width() as u32,
                                        height: image.height() as u32,
                                        rects: Vec::new(),
                                    }),
                                )
                                .await
                                .is_err()
                                {
                                    break;
                                }
                            }
                            Err(e) => {
                                warn!(error = %e, "rdp deactivation-reactivation failed");
                                break;
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Run the [Deactivation-Reactivation Sequence] after a server Deactivate All
/// PDU (the mechanism by which a Display Control resize takes effect): re-run the
/// capability exchange, then re-point the active stage and decoded image at the
/// new desktop size. Returns the reunited transport for the driver to re-split.
///
/// [Deactivation-Reactivation Sequence]: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpbcgr/dfc234ce-481a-4674-9a5d-2a7bafb14432
async fn reactivate(
    mut framed: RdpFramed,
    connector_config: ConnectorConfig,
    stage: &mut ActiveStage,
    image: &mut DecodedImage,
    io_channel_id: u16,
    user_channel_id: u16,
) -> Result<RdpFramed> {
    let mut activation =
        ConnectionActivationSequence::new(connector_config, io_channel_id, user_channel_id);
    let mut buf = WriteBuf::new();
    loop {
        ironrdp_tokio::single_sequence_step(&mut framed, &mut activation, &mut buf)
            .await
            .context("RDP reactivation sequence step failed")?;
        if let ConnectionActivationState::Finalized {
            desktop_size,
            share_id,
            enable_server_pointer,
            pointer_software_rendering,
        } = activation.connection_activation_state()
        {
            *image =
                DecodedImage::new(PixelFormat::RgbA32, desktop_size.width, desktop_size.height);
            // The server may reassign the share id and pointer settings; rebuild
            // the fast-path processor and re-sync the x224 processor to match.
            // Bulk stream compression is never negotiated (connector config sets
            // no compression), so the decompressor stays absent.
            stage.set_share_id(share_id);
            stage.set_fastpath_processor(
                ironrdp::session::fast_path::ProcessorBuilder {
                    io_channel_id,
                    user_channel_id,
                    share_id,
                    enable_server_pointer,
                    pointer_software_rendering,
                    bulk_decompressor: None,
                }
                .build(),
            );
            stage.set_enable_server_pointer(enable_server_pointer);
            debug!(
                width = desktop_size.width,
                height = desktop_size.height,
                "rdp reactivation complete"
            );
            break;
        }
    }
    Ok(framed)
}

/// Encode a batch of CLIPRDR channel messages against the active stage and write
/// the resulting frame on the RDP transport. Building the messages needs a `&mut`
/// borrow of the channel; encoding only needs `&self`, so callers build first,
/// then hand the owned messages here (#1756).
async fn write_cliprdr_messages<T>(
    stage: &ActiveStage,
    transport: &mut T,
    messages: CliprdrSvcMessages<CliprdrRole>,
) -> Result<()>
where
    T: FramedWrite,
{
    let frame = stage
        .process_svc_processor_messages(messages)
        .context("failed to encode cliprdr messages")?;
    transport
        .write_all(&frame)
        .await
        .context("failed to write cliprdr frame")?;
    Ok(())
}

/// Advertise the host's current clipboard formats to the server (an empty list
/// when the host clipboard is empty, which still drives the CLIPRDR init
/// handshake to completion). Called both when the channel first requests a format
/// list and whenever the host copies new text (#1756).
async fn advertise_local_clipboard<T>(
    stage: &mut ActiveStage,
    transport: &mut T,
    local_clipboard: Option<&str>,
) -> Result<()>
where
    T: FramedWrite,
{
    let formats = local_text_formats(local_clipboard);
    let messages = match stage.get_svc_processor_mut::<CliprdrClient>() {
        Some(cliprdr) => cliprdr
            .initiate_copy(&formats)
            .context("cliprdr initiate_copy failed")?,
        None => {
            warn!("cliprdr channel unavailable; cannot advertise local clipboard");
            return Ok(());
        }
    };
    write_cliprdr_messages(stage, transport, messages).await
}

/// Drain the CLIPRDR backend's queued [`ClipboardEvent`]s now that the driver
/// owns the active stage again, performing each channel action (advertise / fetch
/// / provide) or forwarding received remote text to the host over IPC (#1756).
async fn drain_clipboard_events<T, W>(
    rx: &std::sync::mpsc::Receiver<ClipboardEvent>,
    stage: &mut ActiveStage,
    transport: &mut T,
    ipc_out: &mut W,
    local_clipboard: Option<&str>,
) -> Result<()>
where
    T: FramedWrite,
    W: AsyncWrite + Unpin,
{
    while let Ok(event) = rx.try_recv() {
        match event {
            ClipboardEvent::AdvertiseLocal => {
                advertise_local_clipboard(stage, transport, local_clipboard).await?;
            }
            ClipboardEvent::InitiatePaste(format) => {
                let messages = match stage.get_svc_processor_mut::<CliprdrClient>() {
                    Some(cliprdr) => cliprdr
                        .initiate_paste(format)
                        .context("cliprdr initiate_paste failed")?,
                    None => {
                        warn!("cliprdr channel unavailable; cannot paste remote clipboard");
                        continue;
                    }
                };
                write_cliprdr_messages(stage, transport, messages).await?;
            }
            ClipboardEvent::ProvideData(format) => {
                let response = build_format_data_response(format, local_clipboard);
                let messages = match stage.get_svc_processor_mut::<CliprdrClient>() {
                    Some(cliprdr) => cliprdr
                        .submit_format_data(response)
                        .context("cliprdr submit_format_data failed")?,
                    None => {
                        warn!("cliprdr channel unavailable; cannot serve clipboard data");
                        continue;
                    }
                };
                write_cliprdr_messages(stage, transport, messages).await?;
            }
            ClipboardEvent::RemoteText(text) => {
                debug!(len = text.len(), "forwarding remote clipboard text to host");
                write_message(ipc_out, &SidecarMessage::Clipboard(text))
                    .await
                    .context("failed to forward remote clipboard to host")?;
            }
        }
    }
    Ok(())
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
    fn resize_dimensions_are_clamped_to_displaycontrol_range() {
        // The resize handler runs requested pixels through
        // `adjust_display_size` before encoding a Display Control monitor
        // layout. MS-RDPEDISP requires an even width and both dimensions within
        // 200..=8192; an out-of-range or odd value would make the server reject
        // the resize, so this guards the exact values we put on the wire.
        assert_eq!(
            MonitorLayoutEntry::adjust_display_size(1920, 1080),
            (1920, 1080)
        );
        // Odd width rounds down to even.
        assert_eq!(
            MonitorLayoutEntry::adjust_display_size(1367, 769),
            (1366, 769)
        );
        // Below the minimum clamps up to 200.
        assert_eq!(MonitorLayoutEntry::adjust_display_size(10, 10), (200, 200));
        // Above the maximum clamps down to 8192.
        assert_eq!(
            MonitorLayoutEntry::adjust_display_size(10000, 9000),
            (8192, 8192)
        );
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
