//! termiHub fork (#3463): ExtendedDesktopSize (-308) / SetDesktopSize (251).
//!
//! Wire-format tests for the client message, parser tests for the server
//! layout rectangle (including hostile inputs), read-loop tests for how a
//! layout moves the framebuffer, and end-to-end tests through the real client
//! over an in-memory duplex "server".

use std::sync::Mutex;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio::sync::oneshot;

use super::connection::{asycn_vnc_read_loop, ScreenCell};
use super::desktop_size::{
    encode_set_desktop_size, read_extended_desktop_size, validate_request, MAX_DESKTOP_SCREENS,
};
use super::VncClient;
use crate::{
    DesktopScreen, DesktopSizeReason, DesktopSizeRequest, DesktopSizeStatus, PixelFormat, Rect,
    VncEncoding, VncError, VncEvent, X11Event,
};

const RAW: i32 = 0;
const EXT_DESKTOP_SIZE: i32 = -308;
const BELL: u8 = 2;

fn screen(id: u32, x: u16, y: u16, width: u16, height: u16, flags: u32) -> DesktopScreen {
    DesktopScreen {
        id,
        x,
        y,
        width,
        height,
        flags,
    }
}

fn screen_bytes(s: &DesktopScreen) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&s.id.to_be_bytes());
    for n in [s.x, s.y, s.width, s.height] {
        v.extend_from_slice(&n.to_be_bytes());
    }
    v.extend_from_slice(&s.flags.to_be_bytes());
    v
}

fn fb_update(rects: u16) -> Vec<u8> {
    let mut v = vec![0, 0];
    v.extend_from_slice(&rects.to_be_bytes());
    v
}

fn rect(x: u16, y: u16, w: u16, h: u16, encoding: i32) -> Vec<u8> {
    let mut v = Vec::new();
    for n in [x, y, w, h] {
        v.extend_from_slice(&n.to_be_bytes());
    }
    v.extend_from_slice(&encoding.to_be_bytes());
    v
}

/// An ExtendedDesktopSize rectangle: header (reason, status, size) + body.
fn layout_rect(reason: u16, status: u16, w: u16, h: u16, screens: &[DesktopScreen]) -> Vec<u8> {
    let mut v = rect(reason, status, w, h, EXT_DESKTOP_SIZE);
    v.extend_from_slice(&[screens.len() as u8, 0, 0, 0]);
    for s in screens {
        v.extend(screen_bytes(s));
    }
    v
}

/// A raw rectangle carrying `w * h` RGBA pixels.
fn raw_rect(x: u16, y: u16, w: u16, h: u16) -> Vec<u8> {
    let mut v = rect(x, y, w, h, RAW);
    v.extend(std::iter::repeat_n(
        0x7f,
        usize::from(w) * usize::from(h) * 4,
    ));
    v
}

fn with_layout() -> Vec<VncEncoding> {
    vec![
        VncEncoding::Raw,
        VncEncoding::DesktopSizePseudo,
        VncEncoding::ExtendedDesktopSizePseudo,
    ]
}

/// Run the real decoding loop over `bytes` from a `screen`-sized framebuffer,
/// returning its result, the events and the tracked final size.
async fn run(
    bytes: &[u8],
    encodings: &[VncEncoding],
    screen: (u16, u16),
) -> (Result<(), VncError>, Vec<VncEvent>, (u16, u16)) {
    let events = Mutex::new(Vec::new());
    let output = |e: VncEvent| {
        events.lock().unwrap().push(e);
        std::future::ready(Ok::<(), VncError>(()))
    };
    let (_stop_tx, mut stop_rx) = oneshot::channel();
    let cell = ScreenCell::new(screen);
    let mut reader = bytes;
    let pf = PixelFormat::rgba();
    let result =
        asycn_vnc_read_loop(&mut reader, &pf, &output, &mut stop_rx, encodings, &cell).await;
    (result, events.into_inner().unwrap(), cell.get())
}

fn is_eof(r: &Result<(), VncError>) -> bool {
    matches!(r, Err(VncError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof)
}

fn layouts(events: &[VncEvent]) -> Vec<&crate::ExtendedDesktopSize> {
    events
        .iter()
        .filter_map(|e| match e {
            VncEvent::DesktopLayout(l) => Some(l),
            _ => None,
        })
        .collect()
}

fn resolutions(events: &[VncEvent]) -> Vec<(u16, u16)> {
    events
        .iter()
        .filter_map(|e| match e {
            VncEvent::SetResolution(s) => Some((s.width, s.height)),
            _ => None,
        })
        .collect()
}

fn unsupported_count(events: &[VncEvent]) -> usize {
    events
        .iter()
        .filter(|e| matches!(e, VncEvent::DesktopLayoutUnsupported))
        .count()
}

// ------------------------------------------------------- wire format ---

#[test]
fn encoding_number_is_minus_308() {
    assert_eq!(VncEncoding::ExtendedDesktopSizePseudo.wire_value(), -308);
    assert_eq!(
        VncEncoding::from_wire(-308_i32 as u32),
        Some(VncEncoding::ExtendedDesktopSizePseudo)
    );
}

#[test]
fn set_desktop_size_wire_format() {
    let req = DesktopSizeRequest {
        width: 1920,
        height: 1080,
        screens: vec![screen(0x0102_0304, 0, 0, 1920, 1080, 0x0a0b_0c0d)],
    };
    assert_eq!(
        encode_set_desktop_size(&req),
        vec![
            251, 0, // type, padding
            0x07, 0x80, 0x04, 0x38, // 1920 x 1080
            1, 0, // one screen, padding
            1, 2, 3, 4, // id
            0, 0, 0, 0, // x, y
            0x07, 0x80, 0x04, 0x38, // screen size
            0x0a, 0x0b, 0x0c, 0x0d, // flags
        ]
    );
}

#[test]
fn a_valid_request_passes_validation() {
    let req = DesktopSizeRequest {
        width: 1600,
        height: 900,
        screens: vec![screen(1, 0, 0, 800, 900, 0), screen(2, 800, 0, 800, 900, 0)],
    };
    assert!(validate_request(&req).is_ok());
}

#[test]
fn invalid_requests_are_refused_before_the_socket() {
    let one = |w, h| vec![screen(0, 0, 0, w, h, 0)];
    let cases = [
        DesktopSizeRequest {
            width: 0,
            height: 600,
            screens: one(1, 600),
        },
        DesktopSizeRequest {
            width: 8193,
            height: 600,
            screens: one(8193, 600),
        },
        DesktopSizeRequest {
            width: 800,
            height: 600,
            screens: vec![],
        },
        DesktopSizeRequest {
            width: 800,
            height: 600,
            screens: vec![screen(0, 0, 0, 10, 10, 0); MAX_DESKTOP_SCREENS + 1],
        },
        DesktopSizeRequest {
            width: 800,
            height: 600,
            screens: vec![screen(0, 700, 0, 200, 600, 0)],
        },
        DesktopSizeRequest {
            width: 800,
            height: 600,
            screens: vec![screen(0, 0, 0, 0, 600, 0)],
        },
    ];
    for req in cases {
        assert!(
            matches!(validate_request(&req), Err(VncError::General(_))),
            "{req:?}"
        );
    }
}

// ------------------------------------------------------------ parser ---

#[tokio::test]
async fn parses_reason_status_size_and_screens() {
    let screens = [
        screen(7, 0, 0, 1024, 768, 3),
        screen(8, 1024, 0, 800, 600, 0),
    ];
    let bytes = layout_rect(1, 3, 1824, 768, &screens);
    let mut reader = &bytes[12..];
    let header = Rect {
        x: 1,
        y: 3,
        width: 1824,
        height: 768,
    };
    let layout = read_extended_desktop_size(&mut reader, &header)
        .await
        .unwrap();
    assert_eq!(layout.reason, DesktopSizeReason::Client);
    assert_eq!(layout.status, DesktopSizeStatus::InvalidLayout);
    assert_eq!((layout.width, layout.height), (1824, 768));
    assert_eq!(layout.screens, screens.to_vec());
    assert!(reader.is_empty(), "the whole body is consumed");
}

#[test]
fn unknown_reason_and_status_codes_are_kept() {
    assert_eq!(DesktopSizeReason::from(9), DesktopSizeReason::Unknown(9));
    assert_eq!(DesktopSizeStatus::from(4), DesktopSizeStatus::Unknown(4));
    assert_eq!(DesktopSizeStatus::from(1), DesktopSizeStatus::Prohibited);
    assert_eq!(
        DesktopSizeStatus::from(2),
        DesktopSizeStatus::OutOfResources
    );
    assert_eq!(DesktopSizeReason::from(2), DesktopSizeReason::OtherClient);
}

// --------------------------------------------------------- read loop ---

#[tokio::test]
async fn initial_layout_is_reported_without_a_resize() {
    let mut bytes = fb_update(1);
    bytes.extend(layout_rect(0, 0, 640, 480, &[screen(0, 0, 0, 640, 480, 0)]));
    bytes.push(BELL);
    let (result, events, size) = run(&bytes, &with_layout(), (640, 480)).await;
    assert!(is_eof(&result), "{result:?}");
    assert_eq!(layouts(&events).len(), 1);
    assert!(resolutions(&events).is_empty(), "same size: no resize");
    assert_eq!(unsupported_count(&events), 0);
    assert_eq!(size, (640, 480));
}

#[tokio::test]
async fn an_accepted_layout_resizes_the_framebuffer_for_later_rects() {
    let mut bytes = fb_update(2);
    bytes.extend(layout_rect(1, 0, 800, 600, &[screen(0, 0, 0, 800, 600, 0)]));
    // A rectangle only valid in the new, larger framebuffer.
    bytes.extend(raw_rect(790, 590, 10, 10));
    bytes.push(BELL);
    let (result, events, size) = run(&bytes, &with_layout(), (640, 480)).await;
    assert!(is_eof(&result), "{result:?}");
    assert_eq!(resolutions(&events), vec![(800, 600)]);
    assert_eq!(layouts(&events)[0].status, DesktopSizeStatus::Ok);
    assert!(events.iter().any(|e| matches!(e, VncEvent::RawImage(..))));
    assert_eq!(size, (800, 600), "the shared size follows the layout");
}

#[tokio::test]
async fn a_refused_request_keeps_the_framebuffer() {
    let mut bytes = fb_update(2);
    bytes.extend(layout_rect(1, 1, 800, 600, &[screen(0, 0, 0, 800, 600, 0)]));
    bytes.extend(raw_rect(790, 590, 10, 10)); // outside the unchanged 640x480
    let (result, events, size) = run(&bytes, &with_layout(), (640, 480)).await;
    assert!(
        matches!(result, Err(VncError::Protocol(_))),
        "the refused size must not be adopted: {result:?}"
    );
    assert!(resolutions(&events).is_empty());
    assert_eq!(layouts(&events)[0].status, DesktopSizeStatus::Prohibited);
    assert_eq!(size, (640, 480));
}

#[tokio::test]
async fn a_refusal_may_carry_any_size_without_ending_the_session() {
    // A non-zero status's geometry is informational; even an absurd one is
    // not a protocol violation.
    let mut bytes = fb_update(1);
    bytes.extend(layout_rect(1, 2, u16::MAX, u16::MAX, &[]));
    bytes.push(BELL);
    let (result, events, size) = run(&bytes, &with_layout(), (640, 480)).await;
    assert!(is_eof(&result), "{result:?}");
    assert_eq!(layouts(&events).len(), 1);
    assert_eq!(size, (640, 480));
}

#[tokio::test]
async fn a_desktop_size_change_updates_the_shared_size() {
    let mut bytes = fb_update(1);
    bytes.extend(rect(0, 0, 1280, 720, -223));
    let (result, _events, size) = run(&bytes, &with_layout(), (640, 480)).await;
    assert!(is_eof(&result), "{result:?}");
    assert_eq!(size, (1280, 720));
}

#[tokio::test]
async fn a_first_update_without_a_layout_means_unsupported_once() {
    let mut bytes = fb_update(1);
    bytes.extend(raw_rect(0, 0, 2, 2));
    bytes.extend(fb_update(1));
    bytes.extend(raw_rect(0, 0, 2, 2));
    let (result, events, _) = run(&bytes, &with_layout(), (640, 480)).await;
    assert!(is_eof(&result), "{result:?}");
    assert_eq!(unsupported_count(&events), 1);
}

#[tokio::test]
async fn unsupported_is_not_reported_when_the_layout_came_or_was_not_asked_for() {
    let mut with = fb_update(2);
    with.extend(raw_rect(0, 0, 2, 2));
    with.extend(layout_rect(0, 0, 640, 480, &[screen(0, 0, 0, 640, 480, 0)]));
    let (_, events, _) = run(&with, &with_layout(), (640, 480)).await;
    assert_eq!(unsupported_count(&events), 0);

    let mut without = fb_update(1);
    without.extend(raw_rect(0, 0, 2, 2));
    let (_, events, _) = run(&without, &[VncEncoding::Raw], (640, 480)).await;
    assert_eq!(unsupported_count(&events), 0);
}

// ------------------------------------------------------ hostile input ---

#[tokio::test]
async fn too_many_screens_is_a_protocol_error() {
    let screens = vec![screen(0, 0, 0, 1, 1, 0); MAX_DESKTOP_SCREENS + 1];
    let mut bytes = fb_update(1);
    bytes.extend(layout_rect(0, 0, 640, 480, &screens));
    let (result, events, _) = run(&bytes, &with_layout(), (640, 480)).await;
    assert!(matches!(result, Err(VncError::Protocol(_))), "{result:?}");
    assert!(layouts(&events).is_empty());
}

#[tokio::test]
async fn an_oversize_accepted_layout_is_a_protocol_error() {
    let mut bytes = fb_update(1);
    bytes.extend(layout_rect(
        0,
        0,
        8193,
        480,
        &[screen(0, 0, 0, 8193, 480, 0)],
    ));
    let (result, events, size) = run(&bytes, &with_layout(), (640, 480)).await;
    assert!(matches!(result, Err(VncError::Protocol(_))), "{result:?}");
    assert!(resolutions(&events).is_empty());
    assert_eq!(size, (640, 480));
}

#[tokio::test]
async fn a_truncated_layout_is_an_eof_error() {
    let mut bytes = fb_update(1);
    let mut body = layout_rect(0, 0, 640, 480, &[screen(0, 0, 0, 640, 480, 0)]);
    body.truncate(body.len() - 5);
    bytes.extend(body);
    let (result, events, _) = run(&bytes, &with_layout(), (640, 480)).await;
    assert!(is_eof(&result), "{result:?}");
    assert!(layouts(&events).is_empty());
}

#[tokio::test]
async fn a_layout_the_client_did_not_negotiate_is_rejected() {
    let mut bytes = fb_update(1);
    bytes.extend(layout_rect(0, 0, 640, 480, &[screen(0, 0, 0, 640, 480, 0)]));
    let (result, _, _) = run(&bytes, &[VncEncoding::Raw], (640, 480)).await;
    assert!(matches!(result, Err(VncError::Protocol(_))), "{result:?}");
}

#[tokio::test]
async fn random_layouts_never_panic() {
    // Seeded xorshift so failures reproduce.
    let mut state: u64 = 0x5eed_3463;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    for _ in 0..2000 {
        let count = (next() % 24) as u8;
        let mut bytes = fb_update(1);
        bytes.extend(rect(
            (next() % 5) as u16,
            (next() % 6) as u16,
            next() as u16,
            next() as u16,
            EXT_DESKTOP_SIZE,
        ));
        bytes.extend_from_slice(&[count, 0, 0, 0]);
        let body = (next() % (u64::from(count) * 16 + 8)) as usize;
        bytes.extend((0..body).map(|_| next() as u8));
        let (result, _, size) = run(&bytes, &with_layout(), (640, 480)).await;
        assert!(size.0 <= 8192 && size.1 <= 8192, "{size:?}");
        let _ = result;
    }
}

// --------------------------------------------------- through the client ---

fn server_init(w: u16, h: u16) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&w.to_be_bytes());
    v.extend_from_slice(&h.to_be_bytes());
    v.extend(<PixelFormat as Into<Vec<u8>>>::into(PixelFormat::rgba()));
    v.extend_from_slice(&4_u32.to_be_bytes());
    v.extend_from_slice(b"test");
    v
}

/// Connect a client over a duplex pipe and consume everything it sends
/// during setup (ClientInit, SetPixelFormat, SetEncodings and the first
/// FramebufferUpdateRequest).
async fn connected_client(w: u16, h: u16) -> (VncClient, DuplexStream) {
    let encodings = with_layout();
    let set_encodings_len = 4 + 4 * encodings.len();
    let (client_io, mut server) = tokio::io::duplex(1 << 16);
    let connect = tokio::spawn(VncClient::with_event_budget(
        client_io,
        Some(PixelFormat::rgba()),
        encodings,
        1 << 20,
    ));
    let mut shared_flag = [0; 1];
    server.read_exact(&mut shared_flag).await.unwrap();
    server.write_all(&server_init(w, h)).await.unwrap();
    let client = tokio::time::timeout(Duration::from_secs(5), connect)
        .await
        .expect("connect must not hang")
        .unwrap()
        .unwrap();
    let mut setup = vec![0; 20 + set_encodings_len + 10];
    server.read_exact(&mut setup).await.unwrap();
    assert_eq!(
        &setup[20..22],
        &[2, 0],
        "SetEncodings follows SetPixelFormat"
    );
    (client, server)
}

async fn read_msg(server: &mut DuplexStream, len: usize) -> Vec<u8> {
    let mut buf = vec![0; len];
    tokio::time::timeout(Duration::from_secs(5), server.read_exact(&mut buf))
        .await
        .expect("client message")
        .unwrap();
    buf
}

async fn next_event(client: &VncClient) -> VncEvent {
    tokio::time::timeout(Duration::from_secs(5), client.recv_event())
        .await
        .expect("event")
        .unwrap()
}

#[tokio::test]
async fn set_desktop_size_reaches_the_server_and_refresh_follows_the_new_size() {
    let (client, mut server) = connected_client(640, 480).await;
    // Initial events: SetResolution from ServerInit.
    assert!(matches!(
        next_event(&client).await,
        VncEvent::SetResolution(_)
    ));

    let req = DesktopSizeRequest {
        width: 1024,
        height: 768,
        screens: vec![screen(5, 0, 0, 1024, 768, 0)],
    };
    client
        .input(X11Event::SetDesktopSize(req.clone()))
        .await
        .unwrap();
    assert_eq!(
        read_msg(&mut server, 24).await,
        encode_set_desktop_size(&req)
    );

    // The server accepts it.
    let mut reply = fb_update(1);
    reply.extend(layout_rect(1, 0, 1024, 768, &req.screens));
    server.write_all(&reply).await.unwrap();
    let mut saw_resize = false;
    loop {
        match next_event(&client).await {
            VncEvent::SetResolution(s) => {
                assert_eq!((s.width, s.height), (1024, 768));
                saw_resize = true;
            }
            VncEvent::DesktopLayout(l) => {
                assert_eq!(l.reason, DesktopSizeReason::Client);
                break;
            }
            other => panic!("unexpected {other:?}"),
        }
    }
    assert!(saw_resize);

    // Refresh requests now cover the new framebuffer, not the ServerInit one.
    client.input(X11Event::Refresh).await.unwrap();
    let refresh = read_msg(&mut server, 10).await;
    assert_eq!(refresh, vec![3, 1, 0, 0, 0, 0, 0x04, 0x00, 0x03, 0x00]);
    client.close().await.unwrap();
}

#[tokio::test]
async fn an_invalid_request_is_an_error_and_the_session_continues() {
    let (client, mut server) = connected_client(640, 480).await;
    let bad = DesktopSizeRequest {
        width: 0,
        height: 0,
        screens: vec![],
    };
    assert!(client.input(X11Event::SetDesktopSize(bad)).await.is_err());
    // Nothing was written for it; the next message is the refresh.
    client.input(X11Event::FullRefresh).await.unwrap();
    assert_eq!(read_msg(&mut server, 2).await, vec![3, 0]);
    client.close().await.unwrap();
}
