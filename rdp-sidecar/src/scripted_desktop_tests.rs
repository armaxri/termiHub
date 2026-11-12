//! The scripted server's activated desktop (#5426): what the system lane's
//! `rdp_test_server` paints and how it reports the input it receives, driven
//! through the real sidecar session (`run_session`).

use std::sync::Arc;
use std::time::Duration;

use ironrdp_core::encode_vec;
use ironrdp_pdu::input::fast_path::{FastPathInput, FastPathInputEvent, KeyboardFlags};
use ironrdp_pdu::input::mouse::{MousePdu, PointerFlags};
use termihub_core::backends::rdp_sidecar::config::RdpConfig;
use termihub_core::backends::rdp_sidecar::protocol::{
    read_message, write_message, HostMessage, SidecarMessage,
};
use termihub_core::connection::{GraphicalState, InputEvent};

use super::broker::*;

#[test]
fn describe_input_words_keys_and_buttons_and_skips_moves() {
    let pointer = |flags: PointerFlags| {
        FastPathInputEvent::MouseEvent(MousePdu {
            flags,
            number_of_wheel_rotation_units: 0,
            x_position: 100,
            y_position: 50,
        })
    };
    let input = FastPathInput::new(vec![
        FastPathInputEvent::KeyboardEvent(KeyboardFlags::empty(), 0x1E),
        FastPathInputEvent::KeyboardEvent(KeyboardFlags::RELEASE, 0x1E),
        pointer(PointerFlags::MOVE),
        pointer(PointerFlags::LEFT_BUTTON | PointerFlags::DOWN),
        pointer(PointerFlags::LEFT_BUTTON),
        pointer(PointerFlags::RIGHT_BUTTON | PointerFlags::DOWN),
    ])
    .unwrap();
    assert_eq!(
        describe_input(&encode_vec(&input).unwrap()),
        [
            "key 0x1e down",
            "key 0x1e up",
            "button left down 100,50",
            "button left up 100,50",
            "button right down 100,50",
        ]
    );
}

/// Whether a frame paints only the desktop colour (RGBA).
fn is_desktop_colour(frame: &termihub_core::connection::FrameUpdate) -> bool {
    let [r, g, b] = DESKTOP_COLOR;
    !frame.rects.is_empty()
        && frame.rects.iter().all(|rect| {
            rect.data
                .as_chunks::<4>()
                .0
                .iter()
                .all(|px| px[..3] == [r, g, b])
        })
}

/// An activated session paints its whole desktop in the scripted colour, and
/// a key and a click sent by the host reach the server as fast-path input.
#[tokio::test]
async fn an_activated_desktop_paints_and_records_input() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let events: Log = Arc::default();
    let server = spawn_server(
        listener,
        "server",
        BROKER_CERT,
        BROKER_KEY,
        vec![Act::Activate; 4],
        events,
    );
    let cfg = RdpConfig {
        host: "127.0.0.1".to_string(),
        port,
        username: "alice".to_string(),
        password: "saved-password".to_string(),
        connect_timeout_secs: Some(5),
        ..RdpConfig::default()
    };
    let (mut host_writer, mut sidecar_in) = tokio::io::duplex(64 * 1024);
    let (mut sidecar_out, mut host_reader) = tokio::io::duplex(16 * 1024 * 1024);
    let session = super::super::run_session(cfg, &mut sidecar_in, &mut sidecar_out);

    let host = async {
        let mut painted = Vec::new();
        let mut sent_input = false;
        loop {
            let message: SidecarMessage = read_message(&mut host_reader).await.unwrap();
            match message {
                SidecarMessage::CertPrompt { .. } => {
                    let accept = HostMessage::CertDecision {
                        accept: true,
                        remember: false,
                    };
                    write_message(&mut host_writer, &accept).await.unwrap();
                }
                SidecarMessage::State(GraphicalState::Active) if !sent_input => {
                    sent_input = true;
                    for event in [
                        InputEvent::Key {
                            code: "KeyA".to_string(),
                            pressed: true,
                        },
                        InputEvent::Key {
                            code: "KeyA".to_string(),
                            pressed: false,
                        },
                        InputEvent::Pointer {
                            x: 100,
                            y: 50,
                            buttons: 1,
                        },
                        InputEvent::Pointer {
                            x: 100,
                            y: 50,
                            buttons: 0,
                        },
                    ] {
                        write_message(&mut host_writer, &HostMessage::Input(event))
                            .await
                            .unwrap();
                    }
                }
                SidecarMessage::Frame(frame) => {
                    assert_eq!(
                        (frame.width, frame.height),
                        (u32::from(DESKTOP_WIDTH), u32::from(DESKTOP_HEIGHT))
                    );
                    if is_desktop_colour(&frame) {
                        painted.extend(frame.rects.iter().map(|r| (r.x, r.y, r.width, r.height)));
                    }
                }
                _ => {}
            }
            let area: u32 = painted.iter().map(|(_, _, w, h)| w * h).sum();
            let input = server
                .conns()
                .last()
                .map(|c| c.input.clone())
                .unwrap_or_default();
            if area >= u32::from(DESKTOP_WIDTH) * u32::from(DESKTOP_HEIGHT) && input.len() >= 4 {
                return input;
            }
        }
    };

    let input = tokio::time::timeout(Duration::from_secs(30), async {
        tokio::select! {
            result = session => panic!("the session ended on its own: {result:?}"),
            input = host => input,
        }
    })
    .await
    .expect("the desktop painted and the input arrived");
    assert_eq!(
        input,
        [
            "key 0x1e down",
            "key 0x1e up",
            "button left down 100,50",
            "button left up 100,50",
        ]
    );
}
