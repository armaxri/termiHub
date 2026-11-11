//! The scripted RDP servers behind [`super`] (#5271): a connection broker
//! and the server it redirects to, scripted byte for byte on `ironrdp-pdu`.
//!
//! Each connection answers X.224 selecting TLS, completes a TLS handshake
//! with a throwaway certificate (`testdata/redirect_*.der`), runs the MCS
//! connect sequence and licensing, and then plays its [`Act`]. Every byte a
//! connection receives is recorded in its [`Conn`].

use std::borrow::Cow;
use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ironrdp_core::{decode, encode_vec};
use ironrdp_pdu::bitmap::{BitmapData, BitmapUpdateData, Compression};
use ironrdp_pdu::fast_path::{
    EncryptionFlags, FastPathHeader, FastPathUpdatePdu, Fragmentation, UpdateCode,
};
use ironrdp_pdu::gcc::{
    ClientClusterData, ConferenceCreateResponse, RdpVersion, ServerCoreData,
    ServerCoreOptionalData, ServerGccBlocks, ServerNetworkData, ServerSecurityData,
};
use ironrdp_pdu::geometry::InclusiveRectangle;
use ironrdp_pdu::input::fast_path::{FastPathInput, FastPathInputEvent, KeyboardFlags};
use ironrdp_pdu::input::mouse::PointerFlags;
use ironrdp_pdu::mcs::{
    AttachUserConfirm, ChannelJoinConfirm, ConnectInitial, ConnectResponse, DomainParameters,
    McsMessage, SendDataIndication,
};
use ironrdp_pdu::nego::{ConnectionConfirm, ResponseFlags, SecurityProtocol};
use ironrdp_pdu::rdp::capability_sets::{
    Bitmap, BitmapDrawingFlags, CapabilitySet, DemandActive, Input, InputFlags, ServerDemandActive,
};
use ironrdp_pdu::rdp::client_info::CompressionType;
use ironrdp_pdu::rdp::finalization_messages::{ControlAction, ControlPdu, FontPdu, SynchronizePdu};
use ironrdp_pdu::rdp::headers::{
    CompressionFlags, ServerDeactivateAll, ShareControlHeader, ShareControlPdu, ShareDataHeader,
    ShareDataPdu, StreamPriority,
};
use ironrdp_pdu::rdp::server_license::{LicensePdu, LicensingErrorMessage};
use ironrdp_pdu::rdp::server_redirection::ServerRedirectionPdu;
use ironrdp_pdu::rdp::ClientInfoPdu;
use ironrdp_pdu::x224::{X224Data, X224};
use tokio::io::{AsyncRead, AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_rustls::rustls;
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};

pub(super) const BROKER_CERT: &[u8] = include_bytes!("testdata/redirect_broker.cert.der");
pub(super) const BROKER_KEY: &[u8] = include_bytes!("testdata/redirect_broker.key.der");
pub(super) const TARGET_CERT: &[u8] = include_bytes!("testdata/redirect_target.cert.der");
pub(super) const TARGET_KEY: &[u8] = include_bytes!("testdata/redirect_target.key.der");

pub(super) const SERVER_CHANNEL: u16 = 1002;
pub(super) const IO_CHANNEL: u16 = 1003;
pub(super) const USER_CHANNEL: u16 = 1200;
pub(super) const SHARE_ID: u32 = 0x0001_03EA;

/// The size of every scripted desktop.
pub(super) const DESKTOP_WIDTH: u16 = 1024;
pub(super) const DESKTOP_HEIGHT: u16 = 768;
/// The colour an activated [`Act::Activate`] session paints (RGB).
pub(super) const DESKTOP_COLOR: [u8; 3] = [0x00, 0xA0, 0x50];
/// How often an [`Act::Activate`] session repaints its desktop, so a viewer
/// that subscribed late still gets a frame.
pub(super) const REPAINT_EVERY: Duration = Duration::from_secs(2);
/// The edge of one painted tile: a 64x64 32-bpp tile fits one fast-path PDU.
const TILE: u16 = 64;

/// What a scripted server does once the Client Info PDU arrived. A
/// connection that never gets that far (a preflight) needs no act.
#[derive(Clone)]
pub(super) enum Act {
    /// Hang up.
    HangUp,
    /// Activate the session and keep it up until the client hangs up: a
    /// plain, healthy RDP server (the system lane's scripted server, #5175).
    /// Once the client finished the finalization, it paints the whole
    /// desktop [`DESKTOP_COLOR`] and repaints it every [`REPAINT_EVERY`]
    /// (#5426).
    Activate,
    /// Send a Server Redirection where the Demand Active belongs.
    Redirect(ServerRedirectionPdu),
    /// Activate the session, then redirect it.
    RedirectMidSession(ServerRedirectionPdu),
    /// Activate the session, start a reactivation with a Deactivate All, and
    /// redirect inside it.
    RedirectOnReactivation(ServerRedirectionPdu),
}

/// Everything one TCP connection to a scripted server received.
#[derive(Debug, Default, Clone)]
pub(super) struct Conn {
    /// The X.224 Connection Request, as sent.
    pub(super) x224_request: Vec<u8>,
    /// Every byte after the TLS handshake (decrypted).
    pub(super) after_tls: Vec<u8>,
    /// The Client Cluster Data of the MCS Connect Initial.
    pub(super) cluster: Option<ClientClusterData>,
    /// The Client Info PDU's username.
    pub(super) username: Option<String>,
    /// The Client Info PDU's password cookie.
    pub(super) password_cookie: Option<Vec<u8>>,
    /// Key and button input received after activation, as
    /// [`describe_input`] words it (pointer moves are left out).
    pub(super) input: Vec<String>,
}

/// The order things happened in, across servers and the host.
pub(super) type Log = Arc<Mutex<Vec<String>>>;

pub(super) fn log(log: &Log, line: String) {
    log.lock().unwrap().push(line);
}

pub(super) struct Server {
    conns: Arc<Mutex<Vec<Conn>>>,
}

impl Server {
    pub(super) fn conns(&self) -> Vec<Conn> {
        self.conns.lock().unwrap().clone()
    }
}

pub(super) fn tls_acceptor(cert: &[u8], key: &[u8]) -> tokio_rustls::TlsAcceptor {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(cert.to_vec())],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.to_vec())),
        )
        .unwrap();
    tokio_rustls::TlsAcceptor::from(Arc::new(config))
}

/// Serve `listener`: each accepted connection takes the next act of
/// `script` (connections beyond it hang up after the Client Info).
pub(super) fn spawn_server(
    listener: TcpListener,
    label: &'static str,
    cert: &'static [u8],
    key: &'static [u8],
    script: Vec<Act>,
    events: Log,
) -> Server {
    let conns = Arc::new(Mutex::new(Vec::new()));
    let acceptor = tls_acceptor(cert, key);
    let server_conns = Arc::clone(&conns);
    let mut script = VecDeque::from(script);
    tokio::spawn(async move {
        loop {
            let Ok((tcp, _)) = listener.accept().await else {
                return;
            };
            let index = {
                let mut conns = server_conns.lock().unwrap();
                conns.push(Conn::default());
                conns.len() - 1
            };
            log(&events, format!("dial {label} #{}", index + 1));
            let act = script.pop_front().unwrap_or(Act::HangUp);
            tokio::spawn(serve(
                tcp,
                acceptor.clone(),
                act,
                Arc::clone(&server_conns),
                index,
            ));
        }
    });
    Server { conns }
}

/// Read one TPKT or fast-path frame. `Err` carries the bytes of a frame cut
/// short by the end of the stream.
pub(super) async fn read_frame<S: AsyncRead + Unpin>(stream: &mut S) -> Result<Vec<u8>, Vec<u8>> {
    let mut frame = Vec::new();
    let mut byte = [0u8; 1];
    for _ in 0..2 {
        match stream.read_exact(&mut byte).await {
            Ok(_) => frame.push(byte[0]),
            Err(_) => return Err(frame),
        }
    }
    let len = if frame[0] == 0x03 {
        let mut rest = [0u8; 2];
        if stream.read_exact(&mut rest).await.is_err() {
            return Err(frame);
        }
        frame.extend_from_slice(&rest);
        usize::from(u16::from_be_bytes(rest))
    } else if frame[1] & 0x80 != 0 {
        if stream.read_exact(&mut byte).await.is_err() {
            return Err(frame);
        }
        frame.push(byte[0]);
        (usize::from(frame[1] & 0x7F) << 8) | usize::from(byte[0])
    } else {
        usize::from(frame[1])
    };
    let mut body = vec![0u8; len.saturating_sub(frame.len())];
    match stream.read_exact(&mut body).await {
        Ok(_) => {
            frame.extend(body);
            Ok(frame)
        }
        Err(_) => Err(frame),
    }
}

pub(super) fn io_pdu(user_data: Vec<u8>) -> Vec<u8> {
    encode_vec(&X224(SendDataIndication {
        initiator_id: SERVER_CHANNEL,
        channel_id: IO_CHANNEL,
        user_data: Cow::Owned(user_data),
    }))
    .unwrap()
}

pub(super) fn share_control(pdu: ShareControlPdu) -> Vec<u8> {
    io_pdu(
        encode_vec(&ShareControlHeader {
            share_control_pdu: pdu,
            pdu_source: SERVER_CHANNEL,
            share_id: SHARE_ID,
        })
        .unwrap(),
    )
}

pub(super) fn share_data(pdu: ShareDataPdu) -> Vec<u8> {
    share_control(ShareControlPdu::Data(ShareDataHeader {
        share_data_pdu: pdu,
        stream_priority: StreamPriority::Medium,
        compression_flags: CompressionFlags::empty(),
        compression_type: CompressionType::K8,
    }))
}

/// The server half of the capability exchange and finalization: a Demand
/// Active, then Synchronize, Cooperate, Granted Control and Font Map.
pub(super) fn activation() -> Vec<u8> {
    let mut script = share_control(ShareControlPdu::ServerDemandActive(ServerDemandActive {
        pdu: DemandActive {
            source_descriptor: "RDP".to_string(),
            capability_sets: vec![
                CapabilitySet::Bitmap(Bitmap {
                    pref_bits_per_pix: 32,
                    desktop_width: DESKTOP_WIDTH,
                    desktop_height: DESKTOP_HEIGHT,
                    desktop_resize_flag: true,
                    drawing_flags: BitmapDrawingFlags::empty(),
                }),
                // Fast-path input, so the client's input arrives in the form
                // `describe_input` reads.
                CapabilitySet::Input(Input {
                    input_flags: InputFlags::SCANCODES
                        | InputFlags::MOUSEX
                        | InputFlags::FASTPATH_INPUT_2,
                    keyboard_layout: 0,
                    keyboard_type: None,
                    keyboard_subtype: 0,
                    keyboard_function_key: 0,
                    keyboard_ime_filename: String::new(),
                }),
            ],
        },
    }));
    for pdu in [
        ShareDataPdu::Synchronize(SynchronizePdu {
            target_user_id: USER_CHANNEL,
        }),
        ShareDataPdu::Control(ControlPdu {
            action: ControlAction::Cooperate,
            grant_id: 0,
            control_id: 0,
        }),
        ShareDataPdu::Control(ControlPdu {
            action: ControlAction::GrantedControl,
            grant_id: USER_CHANNEL,
            control_id: u32::from(SERVER_CHANNEL),
        }),
        ShareDataPdu::FontMap(FontPdu::default()),
    ] {
        script.extend(share_data(pdu));
    }
    script
}

pub(super) fn redirection(pdu: ServerRedirectionPdu) -> Vec<u8> {
    // The Enhanced Security Server Redirection PDU carries no share id.
    io_pdu(
        encode_vec(&ShareControlHeader {
            share_control_pdu: ShareControlPdu::ServerRedirect(pdu),
            pdu_source: SERVER_CHANNEL,
            share_id: 0,
        })
        .unwrap(),
    )
}

/// The server's answer to the Client Info PDU under `act`; `None` hangs up.
pub(super) fn answer(act: &Act) -> Option<Vec<u8>> {
    let valid_client = LicensePdu::from(LicensingErrorMessage::new_valid_client().unwrap());
    let mut reply = io_pdu(encode_vec(&valid_client).unwrap());
    match act {
        Act::HangUp => return None,
        Act::Activate => reply.extend(activation()),
        Act::Redirect(pdu) => reply.extend(redirection(pdu.clone())),
        Act::RedirectMidSession(pdu) => {
            reply.extend(activation());
            reply.extend(redirection(pdu.clone()));
        }
        Act::RedirectOnReactivation(pdu) => {
            reply.extend(activation());
            reply.extend(share_control(ShareControlPdu::ServerDeactivateAll(
                ServerDeactivateAll,
            )));
            reply.extend(redirection(pdu.clone()));
        }
    }
    Some(reply)
}

/// The whole desktop in [`DESKTOP_COLOR`]: uncompressed 32-bpp (BGRX) fast-path
/// bitmap updates, one [`TILE`]-sized tile per PDU.
pub(super) fn desktop_frames() -> Vec<u8> {
    let [r, g, b] = DESKTOP_COLOR;
    let mut frames = Vec::new();
    for top in (0..DESKTOP_HEIGHT).step_by(usize::from(TILE)) {
        for left in (0..DESKTOP_WIDTH).step_by(usize::from(TILE)) {
            let width = TILE.min(DESKTOP_WIDTH - left);
            let height = TILE.min(DESKTOP_HEIGHT - top);
            let pixels = [b, g, r, 0xFF].repeat(usize::from(width) * usize::from(height));
            let update = encode_vec(&BitmapUpdateData {
                rectangles: vec![BitmapData {
                    rectangle: InclusiveRectangle {
                        left,
                        top,
                        right: left + width - 1,
                        bottom: top + height - 1,
                    },
                    width,
                    height,
                    bits_per_pixel: 32,
                    compression_flags: Compression::empty(),
                    compressed_data_header: None,
                    bitmap_data: &pixels,
                }],
            })
            .unwrap();
            let pdu = encode_vec(&FastPathUpdatePdu {
                fragmentation: Fragmentation::Single,
                update_code: UpdateCode::Bitmap,
                compression_flags: None,
                compression_type: None,
                data: &update,
            })
            .unwrap();
            frames.extend(
                encode_vec(&FastPathHeader::new(EncryptionFlags::empty(), pdu.len())).unwrap(),
            );
            frames.extend(pdu);
        }
    }
    frames
}

/// The key and button events of one fast-path input PDU, one line each:
/// `key 0x1e down`, `button left up 512,384`. Pointer moves are left out.
pub(super) fn describe_input(frame: &[u8]) -> Vec<String> {
    let Ok(input) = decode::<FastPathInput>(frame) else {
        return Vec::new();
    };
    let state = |down: bool| if down { "down" } else { "up" };
    input
        .input_events()
        .iter()
        .filter_map(|event| match event {
            FastPathInputEvent::KeyboardEvent(flags, code) => Some(format!(
                "key 0x{code:02x} {}",
                state(!flags.contains(KeyboardFlags::RELEASE))
            )),
            FastPathInputEvent::MouseEvent(pdu) => {
                let button = [
                    (PointerFlags::LEFT_BUTTON, "left"),
                    (PointerFlags::RIGHT_BUTTON, "right"),
                    (PointerFlags::MIDDLE_BUTTON_OR_WHEEL, "middle"),
                ]
                .into_iter()
                .find(|(flag, _)| pdu.flags.contains(*flag))?
                .1;
                Some(format!(
                    "button {button} {} {},{}",
                    state(pdu.flags.contains(PointerFlags::DOWN)),
                    pdu.x_position,
                    pdu.y_position
                ))
            }
            _ => None,
        })
        .collect()
}

/// Paint the desktop now and every [`REPAINT_EVERY`] until the connection's
/// writer is gone.
fn spawn_painter(tx: mpsc::UnboundedSender<Vec<u8>>) {
    let frames = desktop_frames();
    tokio::spawn(async move {
        while tx.send(frames.clone()).is_ok() {
            tokio::time::sleep(REPAINT_EVERY).await;
        }
    });
}

/// Write everything sent on the returned channel to `writer`, in order.
fn spawn_writer<W>(mut writer: W) -> mpsc::UnboundedSender<Vec<u8>>
where
    W: tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    tokio::spawn(async move {
        while let Some(bytes) = rx.recv().await {
            if writer.write_all(&bytes).await.is_err() {
                return;
            }
        }
    });
    tx
}

pub(super) fn connect_response(initial: &ConnectInitial) -> Vec<u8> {
    let channels = initial
        .conference_create_request
        .gcc_blocks()
        .network
        .as_ref()
        .map_or(0, |network| network.channels.len());
    let channel_ids = (1..=channels)
        .map(|i| IO_CHANNEL + u16::try_from(i).unwrap())
        .collect();
    let blocks = ServerGccBlocks {
        core: ServerCoreData {
            version: RdpVersion::V5_PLUS,
            optional_data: ServerCoreOptionalData {
                client_requested_protocols: Some(SecurityProtocol::SSL),
                early_capability_flags: None,
            },
        },
        network: ServerNetworkData {
            channel_ids,
            io_channel: IO_CHANNEL,
        },
        security: ServerSecurityData::no_security(),
        message_channel: None,
        multi_transport_channel: None,
    };
    let response = ConnectResponse {
        conference_create_response: ConferenceCreateResponse::new(USER_CHANNEL, blocks).unwrap(),
        called_connect_id: 1,
        domain_parameters: DomainParameters::target(),
    };
    encode_vec(&X224(X224Data {
        data: Cow::Owned(encode_vec(&response).unwrap()),
    }))
    .unwrap()
}

/// One connection: X.224 selecting TLS, the TLS handshake, then the MCS
/// connect sequence up to the Client Info PDU, answered under `act`. Every
/// received byte is recorded in `conns[index]`.
pub(super) async fn serve(
    mut tcp: TcpStream,
    acceptor: tokio_rustls::TlsAcceptor,
    act: Act,
    conns: Arc<Mutex<Vec<Conn>>>,
    index: usize,
) {
    let record = |update: &dyn Fn(&mut Conn)| update(&mut conns.lock().unwrap()[index]);

    let request = match read_frame(&mut tcp).await {
        Ok(request) | Err(request) => request,
    };
    record(&|conn| conn.x224_request = request.clone());
    let confirm = encode_vec(&X224(ConnectionConfirm::Response {
        flags: ResponseFlags::empty(),
        protocol: SecurityProtocol::SSL,
    }))
    .unwrap();
    if tcp.write_all(&confirm).await.is_err() {
        return;
    }
    let Ok(tls) = acceptor.accept(tcp).await else {
        return;
    };
    let (mut tls, writer) = tokio::io::split(tls);
    let tx = spawn_writer(writer);
    let mut painting = false;

    loop {
        let frame = match read_frame(&mut tls).await {
            Ok(frame) => frame,
            Err(partial) => {
                record(&|conn| conn.after_tls.extend_from_slice(&partial));
                return;
            }
        };
        record(&|conn| conn.after_tls.extend_from_slice(&frame));

        let reply = if let Ok(X224(McsMessage::SendDataRequest(data))) =
            decode::<X224<McsMessage<'_>>>(&frame)
        {
            match decode::<ClientInfoPdu>(&data.user_data) {
                Ok(info) if data.channel_id == IO_CHANNEL => {
                    let info = info.client_info;
                    record(&|conn| {
                        conn.username = Some(info.credentials.username.clone());
                        conn.password_cookie = info.password_cookie.as_ref().map(|c| c.0.clone());
                    });
                    match answer(&act) {
                        Some(reply) => reply,
                        None => return,
                    }
                }
                // The client's Font List ends its finalization: the session
                // is up, so an activated desktop starts painting.
                _ if matches!(act, Act::Activate)
                    && !painting
                    && data.channel_id == IO_CHANNEL
                    && is_font_list(&data.user_data) =>
                {
                    painting = true;
                    spawn_painter(tx.clone());
                    continue;
                }
                // Confirm Active, the rest of finalization, channel traffic.
                _ => continue,
            }
        } else if let Ok(X224(message)) = decode::<X224<McsMessage<'_>>>(&frame) {
            match message {
                McsMessage::AttachUserRequest(_) => encode_vec(&X224(AttachUserConfirm {
                    result: 0,
                    initiator_id: USER_CHANNEL,
                }))
                .unwrap(),
                McsMessage::ChannelJoinRequest(join) => encode_vec(&X224(ChannelJoinConfirm {
                    result: 0,
                    initiator_id: join.initiator_id,
                    requested_channel_id: join.channel_id,
                    channel_id: join.channel_id,
                }))
                .unwrap(),
                _ => continue,
            }
        } else if let Ok(X224(data)) = decode::<X224<X224Data<'_>>>(&frame) {
            let Ok(initial) = decode::<ConnectInitial>(data.data.as_ref()) else {
                continue;
            };
            let cluster = initial
                .conference_create_request
                .gcc_blocks()
                .cluster
                .clone();
            record(&|conn| conn.cluster = cluster.clone());
            connect_response(&initial)
        } else {
            // Fast-path input after activation.
            let input = describe_input(&frame);
            if !input.is_empty() {
                record(&|conn| conn.input.extend(input.iter().cloned()));
            }
            continue;
        };
        if tx.send(reply).is_err() {
            return;
        }
    }
}

/// Whether a Send Data Request's user data is the client's Font List PDU.
fn is_font_list(user_data: &[u8]) -> bool {
    matches!(
        decode::<ShareControlHeader>(user_data),
        Ok(ShareControlHeader {
            share_control_pdu: ShareControlPdu::Data(ShareDataHeader {
                share_data_pdu: ShareDataPdu::FontList(_),
                ..
            }),
            ..
        })
    )
}

/// A broker on `127.0.0.1:P` and a target on `[::1]:P`: a redirection keeps
/// the port, so both need the same one.
pub(super) async fn bind_pair() -> (TcpListener, TcpListener, u16) {
    for _ in 0..50 {
        let broker = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = broker.local_addr().unwrap().port();
        if let Ok(target) =
            TcpListener::bind(SocketAddr::from(([0u16, 0, 0, 0, 0, 0, 0, 1], port))).await
        {
            return (broker, target, port);
        }
    }
    panic!("no port free on both 127.0.0.1 and ::1 (is IPv6 loopback available?)");
}
