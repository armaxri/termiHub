//! termiHub fork (#3472): Extended Clipboard codec, caps and negotiation.

use std::io::Write;
use std::sync::Mutex;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio::sync::{mpsc, oneshot};

use super::*;
use crate::client::connection::{asycn_vnc_read_loop_with, ClipboardLink, ScreenCell};
use crate::client::messages::{ClientMsg, ServerMsg};
use crate::{PixelFormat, VncClient, VncEncoding, X11Event};

const BELL: u8 = 2;
const TEXT_ONLY: u32 = FORMAT_TEXT;
const TEXT_AND_DIB: u32 = FORMAT_TEXT | FORMAT_DIB;

/// One piece of a `provide` payload: literal bytes, or `n` zero bytes streamed
/// into the compressor without materialising them.
enum Part {
    Bytes(Vec<u8>),
    Zeros(u64),
}

/// A raw `provide` payload (flags + zlib body) announcing `sizes[i]` for each
/// part, which need not match the part's real length.
fn provide_payload(formats: u32, parts: &[(u32, Part)]) -> Vec<u8> {
    let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
    for (size, part) in parts {
        enc.write_all(&size.to_be_bytes()).unwrap();
        match part {
            Part::Bytes(b) => enc.write_all(b).unwrap(),
            Part::Zeros(n) => {
                let chunk = [0u8; 64 * 1024];
                let mut left = *n;
                while left > 0 {
                    let k = left.min(chunk.len() as u64) as usize;
                    enc.write_all(&chunk[..k]).unwrap();
                    left -= k as u64;
                }
            }
        }
    }
    let mut payload = (ACTION_PROVIDE | formats).to_be_bytes().to_vec();
    payload.extend(enc.finish().unwrap());
    payload
}

/// Split an encoded extended `ClientCutText` into its payload, checking the
/// header: type 6, padding, negative length matching the payload.
fn payload_of(message: &[u8]) -> &[u8] {
    assert_eq!(&message[..4], &[6, 0, 0, 0]);
    let len = i32::from_be_bytes(message[4..8].try_into().unwrap());
    assert!(len < 0, "extended messages carry a negative length");
    assert_eq!(len.unsigned_abs() as usize, message.len() - 8);
    &message[8..]
}

/// The server-side framing of `payload`: `ServerCutText` with `-len`.
fn server_ext(payload: &[u8]) -> Vec<u8> {
    let mut v = vec![3, 0, 0, 0];
    v.extend_from_slice(&(-(payload.len() as i32)).to_be_bytes());
    v.extend_from_slice(payload);
    v
}

fn round_trip(msg: &ExtMsg, wanted: u32) -> ExtMsg {
    let encoded = encode(msg).unwrap();
    parse(payload_of(&encoded), wanted).unwrap()
}

fn caps(formats: u32, actions: u32, sizes: &[(u32, u32)]) -> Caps {
    let mut c = Caps {
        formats,
        actions,
        sizes: [0; 16],
    };
    for (format, size) in sizes {
        c.sizes[format.trailing_zeros() as usize] = *size;
    }
    c
}

/// What a TigerVNC server announces: text only, every action, 20 MiB.
fn tigervnc_caps() -> Caps {
    caps(
        FORMAT_TEXT,
        ACTION_CAPS | ACTION_REQUEST | ACTION_PEEK | ACTION_NOTIFY | ACTION_PROVIDE,
        &[(FORMAT_TEXT, 20 * 1024 * 1024)],
    )
}

fn provide(items: Vec<(u32, Vec<u8>)>) -> ExtMsg {
    ExtMsg::Provide(Provide { items, dropped: 0 })
}

// ------------------------------------------------------------------- codec --

#[test]
fn every_action_round_trips() {
    let c = caps(
        FORMAT_TEXT | FORMAT_HTML | FORMAT_DIB,
        ACTION_CAPS | ACTION_REQUEST | ACTION_PROVIDE,
        &[(FORMAT_TEXT, 7), (FORMAT_HTML, 8), (FORMAT_DIB, 9)],
    );
    assert_eq!(round_trip(&ExtMsg::Caps(c.clone()), TEXT_ONLY), ExtMsg::Caps(c));
    for msg in [
        ExtMsg::Request(FORMAT_TEXT | FORMAT_DIB),
        ExtMsg::Peek,
        ExtMsg::Notify(FORMAT_TEXT),
        ExtMsg::Notify(0),
    ] {
        assert_eq!(round_trip(&msg, TEXT_ONLY), msg);
    }
    let both = provide(vec![
        (FORMAT_TEXT, encode_text("日本\ncafé")),
        (FORMAT_DIB, vec![1, 2, 3, 4]),
    ]);
    assert_eq!(round_trip(&both, TEXT_AND_DIB), both);
}

#[test]
fn caps_sizes_follow_format_bit_order() {
    // text, html, dib set: sizes arrive as three U32s in bit order.
    let mut payload = (ACTION_CAPS | FORMAT_DIB | FORMAT_HTML | FORMAT_TEXT)
        .to_be_bytes()
        .to_vec();
    for size in [10u32, 20, 30] {
        payload.extend_from_slice(&size.to_be_bytes());
    }
    let ExtMsg::Caps(c) = parse(&payload, TEXT_ONLY).unwrap() else {
        panic!("expected caps");
    };
    assert_eq!(c.size_of(FORMAT_TEXT), 10);
    assert_eq!(c.size_of(FORMAT_HTML), 20);
    assert_eq!(c.size_of(FORMAT_DIB), 30);
    assert_eq!(c.size_of(FORMAT_RTF), 0);
}

#[test]
fn provide_items_are_encoded_in_bit_order_whatever_the_input_order() {
    let msg = provide(vec![(FORMAT_DIB, vec![9]), (FORMAT_TEXT, b"a\0".to_vec())]);
    let ExtMsg::Provide(p) = round_trip(&msg, TEXT_AND_DIB) else {
        panic!("expected provide");
    };
    assert_eq!(p.items, vec![(FORMAT_TEXT, b"a\0".to_vec()), (FORMAT_DIB, vec![9])]);
}

#[test]
fn encoding_rejects_invalid_provide_formats() {
    for items in [
        vec![(0, vec![])],
        vec![(FORMAT_TEXT | FORMAT_DIB, vec![])],
        vec![(1 << 16, vec![])],
        vec![(FORMAT_TEXT, vec![]), (FORMAT_TEXT, vec![])],
    ] {
        assert!(encode(&provide(items)).is_err());
    }
}

#[test]
fn provide_skips_formats_the_client_did_not_ask_for() {
    let payload = provide_payload(
        FORMAT_TEXT | FORMAT_RTF | FORMAT_HTML | FORMAT_DIB,
        &[
            (3, Part::Bytes(b"hi\0".to_vec())),
            (4, Part::Bytes(b"{rtf".to_vec())),
            (5, Part::Bytes(b"<b>x</b>"[..5].to_vec())),
            (2, Part::Bytes(vec![7, 8])),
        ],
    );
    let ExtMsg::Provide(p) = parse(&payload, TEXT_ONLY).unwrap() else {
        panic!("expected provide");
    };
    assert_eq!(p.items, vec![(FORMAT_TEXT, b"hi\0".to_vec())]);
    assert_eq!(p.dropped, 0, "unwanted formats are skipped, not dropped");

    let ExtMsg::Provide(p) = parse(&payload, TEXT_AND_DIB).unwrap() else {
        panic!("expected provide");
    };
    assert_eq!(
        p.items,
        vec![(FORMAT_TEXT, b"hi\0".to_vec()), (FORMAT_DIB, vec![7, 8])]
    );
}

#[test]
fn files_in_a_provide_are_skipped() {
    let payload = provide_payload(
        FORMAT_TEXT | FORMAT_FILES,
        &[
            (2, Part::Bytes(b"x\0".to_vec())),
            (3, Part::Bytes(b"abc".to_vec())),
        ],
    );
    let ExtMsg::Provide(p) = parse(&payload, TEXT_AND_DIB).unwrap() else {
        panic!("expected provide");
    };
    assert_eq!(p.items, vec![(FORMAT_TEXT, b"x\0".to_vec())]);
}

// ----------------------------------------------------------- caps and bombs --

#[test]
fn an_over_cap_text_is_dropped_without_buffering_and_later_formats_survive() {
    // 16 MiB + 1 of zeros compresses to a few KiB: a small zlib bomb.
    let over = MAX_EXT_CLIPBOARD_TEXT_BYTES + 1;
    let payload = provide_payload(
        FORMAT_TEXT | FORMAT_DIB,
        &[
            (over, Part::Zeros(u64::from(over))),
            (1, Part::Bytes(vec![42])),
        ],
    );
    assert!(payload.len() < 1024 * 1024, "the bomb must be small on the wire");
    let ExtMsg::Provide(p) = parse(&payload, TEXT_AND_DIB).unwrap() else {
        panic!("expected provide");
    };
    assert_eq!(p.dropped, FORMAT_TEXT);
    assert_eq!(p.items, vec![(FORMAT_DIB, vec![42])]);
}

#[test]
fn an_over_cap_dib_is_dropped() {
    let over = MAX_CLIPBOARD_DIB_BYTES + 1;
    let payload = provide_payload(FORMAT_DIB, &[(over, Part::Zeros(u64::from(over)))]);
    let ExtMsg::Provide(p) = parse(&payload, TEXT_AND_DIB).unwrap() else {
        panic!("expected provide");
    };
    assert_eq!(p.dropped, FORMAT_DIB);
    assert!(p.items.is_empty());
}

#[test]
fn the_total_decompression_budget_stops_a_bomb_across_formats() {
    // 40 MiB of (skipped) rtf leaves 24 MiB of budget: a 30 MiB dib announced
    // next is dropped before a byte of it is decompressed, as is the rest.
    let rtf = 40 * 1024 * 1024;
    let payload = provide_payload(
        FORMAT_RTF | FORMAT_DIB,
        &[(rtf, Part::Zeros(u64::from(rtf))), (30 * 1024 * 1024, Part::Zeros(0))],
    );
    let ExtMsg::Provide(p) = parse(&payload, TEXT_AND_DIB).unwrap() else {
        panic!("expected provide");
    };
    assert_eq!(p.dropped, FORMAT_DIB);
    assert!(p.items.is_empty());
}

#[test]
fn a_huge_announced_size_is_refused_before_allocating() {
    // Announces 4 GiB of text but carries nothing: must stop on the budget,
    // never try to reserve the announced size.
    let payload = provide_payload(FORMAT_TEXT, &[(u32::MAX, Part::Bytes(vec![]))]);
    let ExtMsg::Provide(p) = parse(&payload, TEXT_ONLY).unwrap() else {
        panic!("expected provide");
    };
    assert_eq!(p.dropped, FORMAT_TEXT);
}

// -------------------------------------------------- malformed and truncated --

#[test]
fn short_payloads_are_truncated() {
    assert_eq!(parse(&[], TEXT_ONLY), Err(ExtClipboardError::Truncated));
    assert_eq!(parse(&[0x10, 0, 0], TEXT_ONLY), Err(ExtClipboardError::Truncated));
    // Caps for text + dib with only one size.
    let mut payload = (ACTION_CAPS | FORMAT_TEXT | FORMAT_DIB).to_be_bytes().to_vec();
    payload.extend_from_slice(&5u32.to_be_bytes());
    assert_eq!(parse(&payload, TEXT_ONLY), Err(ExtClipboardError::Truncated));
}

#[test]
fn unknown_or_combined_actions_are_rejected() {
    for flags in [
        FORMAT_TEXT,
        ACTION_REQUEST | ACTION_PEEK,
        1 << 29,
        ACTION_NOTIFY | ACTION_PROVIDE,
    ] {
        assert!(matches!(
            parse(&flags.to_be_bytes(), TEXT_ONLY),
            Err(ExtClipboardError::UnknownAction(_))
        ));
    }
}

#[test]
fn a_provide_whose_data_ends_early_is_truncated() {
    // Announces 100 bytes of text, carries 3.
    let payload = provide_payload(FORMAT_TEXT, &[(100, Part::Bytes(b"abc".to_vec()))]);
    assert_eq!(parse(&payload, TEXT_ONLY), Err(ExtClipboardError::Truncated));
    // The same for a skipped format.
    let payload = provide_payload(FORMAT_RTF, &[(100, Part::Bytes(b"abc".to_vec()))]);
    assert_eq!(parse(&payload, TEXT_ONLY), Err(ExtClipboardError::Truncated));
    // A missing size field.
    let payload = provide_payload(FORMAT_TEXT | FORMAT_DIB, &[(1, Part::Bytes(b"a".to_vec()))]);
    assert_eq!(parse(&payload, TEXT_AND_DIB), Err(ExtClipboardError::Truncated));
    // No zlib body at all.
    assert_eq!(
        parse(&(ACTION_PROVIDE | FORMAT_TEXT).to_be_bytes(), TEXT_ONLY),
        Err(ExtClipboardError::Truncated)
    );
}

#[test]
fn a_corrupt_zlib_stream_is_rejected() {
    let mut payload = (ACTION_PROVIDE | FORMAT_TEXT).to_be_bytes().to_vec();
    payload.extend_from_slice(&[0xFF; 32]);
    assert!(matches!(
        parse(&payload, TEXT_ONLY),
        Err(ExtClipboardError::Zlib(_))
    ));
}

#[test]
fn a_provide_with_no_formats_is_empty() {
    let payload = provide_payload(0, &[]);
    assert_eq!(parse(&payload, TEXT_ONLY), Ok(provide(vec![])));
}

// -------------------------------------------------------------------- text --

#[test]
fn text_is_crlf_and_nul_terminated_on_the_wire() {
    assert_eq!(encode_text("a\nb\r\nc\rd"), b"a\r\nb\r\nc\r\nd\0".to_vec());
    assert_eq!(encode_text(""), b"\0".to_vec());
    assert_eq!(encode_text("x\0y"), b"xy\0".to_vec());
    assert_eq!(encode_text("日本"), ["日本".as_bytes(), b"\0"].concat());
}

#[test]
fn text_decodes_to_lf_and_stops_at_the_nul() {
    assert_eq!(decode_text(b"a\r\nb\0junk".to_vec()), "a\nb");
    assert_eq!(decode_text(b"no nul".to_vec()), "no nul");
    assert_eq!(decode_text(["日本 🎉".as_bytes(), b"\0"].concat()), "日本 🎉");
    // A non-conforming Latin-1 payload still decodes, as on the legacy path.
    assert_eq!(decode_text(vec![b'c', b'a', b'f', 0xE9, 0]), "café");
}

#[test]
fn non_latin1_text_survives_the_round_trip() {
    let text = "Grüße, 日本語, emoji 🎉\nsecond line";
    assert_eq!(decode_text(encode_text(text)), text);
}

// ----------------------------------------------------------- state machine --

fn negotiated(wanted: u32, server: Caps) -> ExtClipboardState {
    let mut state = ExtClipboardState::new(Some(wanted));
    state.on_server(ExtMsg::Caps(server));
    state
}

#[test]
fn server_caps_are_answered_with_client_caps_and_reported() {
    let mut state = ExtClipboardState::new(Some(TEXT_ONLY));
    let reaction = state.on_server(ExtMsg::Caps(tigervnc_caps()));
    assert!(matches!(
        reaction.events.as_slice(),
        [VncEvent::ClipboardCapabilities(ClipboardCapabilities {
            text: true,
            images: false
        })]
    ));
    let [ExtMsg::Caps(reply)] = reaction.replies.as_slice() else {
        panic!("expected a caps reply, got {:?}", reaction.replies);
    };
    assert_eq!(reply.formats, FORMAT_TEXT);
    assert_eq!(reply.actions, CLIENT_ACTIONS);
    assert_eq!(reply.size_of(FORMAT_TEXT), MAX_EXT_CLIPBOARD_TEXT_BYTES);
}

#[test]
fn images_are_reported_only_when_both_sides_want_dib() {
    let dib_server = caps(
        FORMAT_TEXT | FORMAT_DIB,
        ACTION_CAPS | ACTION_REQUEST | ACTION_NOTIFY | ACTION_PROVIDE,
        &[(FORMAT_TEXT, 1024), (FORMAT_DIB, 1024)],
    );
    for (wanted, server, expected) in [
        (TEXT_AND_DIB, dib_server.clone(), true),
        (TEXT_ONLY, dib_server.clone(), false),
        (TEXT_AND_DIB, tigervnc_caps(), false),
    ] {
        let mut state = ExtClipboardState::new(Some(wanted));
        let reaction = state.on_server(ExtMsg::Caps(server));
        assert!(
            matches!(
                reaction.events.as_slice(),
                [VncEvent::ClipboardCapabilities(c)] if c.images == expected
            ),
            "{:?}",
            reaction.events
        );
        let [ExtMsg::Caps(reply)] = reaction.replies.as_slice() else {
            panic!("expected a caps reply");
        };
        assert_eq!(reply.formats & FORMAT_DIB != 0, wanted & FORMAT_DIB != 0);
        if wanted & FORMAT_DIB != 0 {
            assert_eq!(reply.size_of(FORMAT_DIB), MAX_CLIPBOARD_DIB_BYTES);
        }
    }
}

#[test]
fn local_text_uses_the_legacy_path_until_the_server_announces_caps() {
    let mut state = ExtClipboardState::new(Some(TEXT_ONLY));
    assert_eq!(state.on_local_text("x"), None);
    // A server whose caps lack text keeps the legacy path too.
    let mut state = negotiated(TEXT_ONLY, caps(FORMAT_DIB, ACTION_PROVIDE, &[]));
    assert_eq!(state.on_local_text("x"), None);
    // As does one that can neither be provided to nor notified.
    let mut state = negotiated(TEXT_ONLY, caps(FORMAT_TEXT, ACTION_REQUEST, &[]));
    assert_eq!(state.on_local_text("x"), None);
    assert_eq!(state.on_server(ExtMsg::Request(FORMAT_TEXT)).replies, vec![]);
}

#[test]
fn small_local_text_is_provided_unsolicited() {
    let mut state = negotiated(TEXT_ONLY, tigervnc_caps());
    assert_eq!(
        state.on_local_text("日本"),
        Some(provide(vec![(FORMAT_TEXT, encode_text("日本"))]))
    );
}

#[test]
fn large_local_text_is_notified_then_provided_on_request() {
    let mut state = negotiated(
        TEXT_ONLY,
        caps(
            FORMAT_TEXT,
            ACTION_REQUEST | ACTION_NOTIFY | ACTION_PROVIDE,
            &[(FORMAT_TEXT, 4)],
        ),
    );
    assert_eq!(state.on_local_text("too long"), Some(ExtMsg::Notify(FORMAT_TEXT)));
    assert_eq!(
        state.on_server(ExtMsg::Peek).replies,
        vec![ExtMsg::Notify(FORMAT_TEXT)]
    );
    assert_eq!(
        state.on_server(ExtMsg::Request(FORMAT_TEXT)).replies,
        vec![provide(vec![(FORMAT_TEXT, encode_text("too long"))])]
    );
    // A request for a format we do not hold gets nothing.
    assert_eq!(state.on_server(ExtMsg::Request(FORMAT_DIB)).replies, vec![]);
}

#[test]
fn a_server_that_cannot_be_notified_gets_a_provide_regardless_of_size() {
    let mut state = negotiated(TEXT_ONLY, caps(FORMAT_TEXT, ACTION_PROVIDE, &[]));
    assert!(matches!(state.on_local_text("x"), Some(ExtMsg::Provide(_))));
}

#[test]
fn a_server_notify_requests_the_wanted_formats_and_supersedes_local_data() {
    let mut state = negotiated(TEXT_ONLY, tigervnc_caps());
    state.on_local_text("mine");
    let reaction = state.on_server(ExtMsg::Notify(FORMAT_TEXT | FORMAT_RTF | FORMAT_DIB));
    assert_eq!(reaction.replies, vec![ExtMsg::Request(FORMAT_TEXT)]);
    assert_eq!(state.on_server(ExtMsg::Peek).replies, vec![ExtMsg::Notify(0)]);
    // Nothing wanted: no request.
    assert_eq!(state.on_server(ExtMsg::Notify(FORMAT_RTF)).replies, vec![]);
    // A server without `request` is not asked.
    let mut state = negotiated(TEXT_ONLY, caps(FORMAT_TEXT, ACTION_PROVIDE, &[]));
    assert_eq!(state.on_server(ExtMsg::Notify(FORMAT_TEXT)).replies, vec![]);
}

#[test]
fn a_server_provide_becomes_text_and_dib_events() {
    let mut state = negotiated(TEXT_AND_DIB, tigervnc_caps());
    let reaction = state.on_server(ExtMsg::Provide(Provide {
        items: vec![
            (FORMAT_TEXT, b"a\r\nb\0".to_vec()),
            (FORMAT_DIB, vec![1, 2]),
        ],
        dropped: FORMAT_HTML,
    }));
    assert_eq!(reaction.dropped, FORMAT_HTML);
    assert!(matches!(
        reaction.events.as_slice(),
        [VncEvent::Text(t), VncEvent::ClipboardDib(d)] if t == "a\nb" && d == &[1, 2]
    ));
}

#[test]
fn local_images_need_a_server_that_announced_dib() {
    let mut state = negotiated(TEXT_AND_DIB, tigervnc_caps());
    assert!(state.on_local_dib(vec![1]).is_err());
    let mut state = ExtClipboardState::new(Some(TEXT_AND_DIB));
    assert!(state.on_local_dib(vec![1]).is_err(), "no caps yet");
    let mut state = negotiated(
        TEXT_AND_DIB,
        caps(
            FORMAT_TEXT | FORMAT_DIB,
            ACTION_REQUEST | ACTION_NOTIFY | ACTION_PROVIDE,
            &[(FORMAT_DIB, 1024)],
        ),
    );
    assert_eq!(
        state.on_local_dib(vec![1, 2, 3]).unwrap(),
        provide(vec![(FORMAT_DIB, vec![1, 2, 3])])
    );
    let too_big = vec![0; MAX_CLIPBOARD_DIB_BYTES as usize + 1];
    assert!(state.on_local_dib(too_big).is_err());
    // A text-only client never announces a dib.
    let mut state = negotiated(TEXT_ONLY, caps(FORMAT_DIB, ACTION_PROVIDE, &[]));
    assert!(state.on_local_dib(vec![1]).is_err());
}

#[test]
fn a_client_that_did_not_advertise_ignores_everything() {
    let mut state = ExtClipboardState::new(None);
    let reaction = state.on_server(ExtMsg::Caps(tigervnc_caps()));
    assert!(reaction.replies.is_empty() && reaction.events.is_empty());
    assert_eq!(state.on_local_text("x"), None);
}

#[test]
fn advertised_formats_follow_the_encoding_list() {
    assert_eq!(advertised_formats(&[VncEncoding::Raw]), None);
    assert_eq!(
        advertised_formats(&[
            VncEncoding::Raw,
            VncEncoding::ExtendedClipboardPseudo { images: false }
        ]),
        Some(TEXT_ONLY)
    );
    assert_eq!(
        advertised_formats(&[VncEncoding::ExtendedClipboardPseudo { images: true }]),
        Some(TEXT_AND_DIB)
    );
}

// ----------------------------------------------------------- wire framing --

#[tokio::test]
async fn a_negative_length_is_the_extended_form_only_when_advertised() {
    let mut bytes = server_ext(&encode_payload(&ExtMsg::Caps(tigervnc_caps())));
    bytes.push(BELL);
    let mut reader = bytes.as_slice();
    let msg = ServerMsg::read_with(&mut reader, Some(TEXT_ONLY)).await.unwrap();
    assert!(matches!(msg, ServerMsg::ExtendedClipboard(ExtMsg::Caps(_))));
    assert!(matches!(
        ServerMsg::read_with(&mut reader, Some(TEXT_ONLY)).await.unwrap(),
        ServerMsg::Bell
    ));
    // Without the extension the length is an (oversize) u32 and is skipped;
    // here the stream ends long before 4 GiB, which is an error, never an
    // extended message.
    assert!(ServerMsg::read(&mut bytes.as_slice()).await.is_err());
}

/// The payload of a message as a server would send it (flags + body).
fn encode_payload(msg: &ExtMsg) -> Vec<u8> {
    payload_of(&encode(msg).unwrap()).to_vec()
}

#[tokio::test]
async fn a_legacy_cut_text_still_works_with_the_extension_advertised() {
    let mut bytes = vec![3, 0, 0, 0, 0, 0, 0, 3, b'n', 0xE4, b'h'];
    bytes.push(BELL);
    let mut reader = bytes.as_slice();
    assert!(matches!(
        ServerMsg::read_with(&mut reader, Some(TEXT_ONLY)).await.unwrap(),
        ServerMsg::ServerCutText(t) if t == "näh"
    ));
}

#[tokio::test]
async fn an_over_cap_wire_payload_is_skipped_and_the_stream_stays_in_sync() {
    let len = MAX_EXT_CLIPBOARD_WIRE_BYTES + 1;
    let mut bytes = vec![3, 0, 0, 0];
    bytes.extend_from_slice(&(-(len as i32)).to_be_bytes());
    bytes.resize(8 + len as usize, 0);
    bytes.push(BELL);
    let mut reader = bytes.as_slice();
    assert!(matches!(
        ServerMsg::read_with(&mut reader, Some(TEXT_ONLY)).await.unwrap(),
        ServerMsg::ExtendedClipboardDropped(ExtClipboardError::TooLarge(n)) if n == len
    ));
    assert!(matches!(
        ServerMsg::read_with(&mut reader, Some(TEXT_ONLY)).await.unwrap(),
        ServerMsg::Bell
    ));
}

#[tokio::test]
async fn i32_min_is_handled_without_overflow() {
    let mut bytes = vec![3, 0, 0, 0];
    bytes.extend_from_slice(&i32::MIN.to_be_bytes());
    // 2 GiB announced: over the cap, skipped — the short stream is an EOF.
    assert!(ServerMsg::read_with(&mut bytes.as_slice(), Some(TEXT_ONLY))
        .await
        .is_err());
}

#[tokio::test]
async fn a_truncated_extended_payload_is_an_eof() {
    let mut bytes = vec![3, 0, 0, 0];
    bytes.extend_from_slice(&(-100i32).to_be_bytes());
    bytes.extend_from_slice(&[0; 10]);
    let err = ServerMsg::read_with(&mut bytes.as_slice(), Some(TEXT_ONLY))
        .await
        .unwrap_err();
    assert!(matches!(err, VncError::IoError(e) if e.kind() == std::io::ErrorKind::UnexpectedEof));
}

#[tokio::test]
async fn a_malformed_extended_message_is_dropped_and_the_stream_stays_in_sync() {
    let mut bytes = server_ext(&(1u32 << 30).to_be_bytes());
    bytes.extend(server_ext(&[1, 2]));
    bytes.push(BELL);
    let mut reader = bytes.as_slice();
    for _ in 0..2 {
        assert!(matches!(
            ServerMsg::read_with(&mut reader, Some(TEXT_ONLY)).await.unwrap(),
            ServerMsg::ExtendedClipboardDropped(_)
        ));
    }
    assert!(matches!(
        ServerMsg::read_with(&mut reader, Some(TEXT_ONLY)).await.unwrap(),
        ServerMsg::Bell
    ));
}

// ------------------------------------------------------- decoding loop --

/// Run the decoding loop over `bytes` with `encodings`, linked to a reply
/// queue; returns the events and the encoded replies.
async fn run_loop(bytes: &[u8], encodings: &[VncEncoding]) -> (Vec<VncEvent>, Vec<Vec<u8>>) {
    let events = Mutex::new(Vec::new());
    let output = |e: VncEvent| {
        events.lock().unwrap().push(e);
        std::future::ready(Ok::<(), VncError>(()))
    };
    let (tx, mut rx) = mpsc::channel(16);
    let link = ClipboardLink {
        state: std::sync::Arc::new(std::sync::Mutex::new(ExtClipboardState::new(
            advertised_formats(encodings),
        ))),
        replies: tx,
    };
    let (_stop_tx, mut stop_rx) = oneshot::channel();
    let screen = ScreenCell::new((64, 64));
    let mut reader = bytes;
    let result = asycn_vnc_read_loop_with(
        &mut reader,
        &PixelFormat::rgba(),
        &output,
        &mut stop_rx,
        encodings,
        &screen,
        Some(&link),
    )
    .await;
    assert!(
        matches!(&result, Err(VncError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof),
        "{result:?}"
    );
    drop(link);
    let mut replies = Vec::new();
    while let Some(msg) = rx.recv().await {
        match msg {
            ClientMsg::ExtendedClipboard(bytes) => replies.push(bytes),
            other => panic!("unexpected reply {other:?}"),
        }
    }
    (events.into_inner().unwrap(), replies)
}

#[tokio::test]
async fn the_decoder_answers_caps_and_requests_notified_text() {
    let mut bytes = server_ext(&encode_payload(&ExtMsg::Caps(tigervnc_caps())));
    bytes.extend(server_ext(&(ACTION_NOTIFY | FORMAT_TEXT).to_be_bytes()));
    bytes.extend(server_ext(&provide_payload(
        FORMAT_TEXT,
        &[(7, Part::Bytes("日本\0".as_bytes().to_vec()))],
    )));
    let encodings = [VncEncoding::Raw, VncEncoding::ExtendedClipboardPseudo { images: false }];
    let (events, replies) = run_loop(&bytes, &encodings).await;
    assert!(matches!(
        events.as_slice(),
        [VncEvent::ClipboardCapabilities(ClipboardCapabilities { text: true, images: false }),
         VncEvent::Text(t)] if t == "日本"
    ));
    let replies: Vec<ExtMsg> = replies
        .iter()
        .map(|r| parse(payload_of(r), TEXT_AND_DIB).unwrap())
        .collect();
    assert!(matches!(&replies[0], ExtMsg::Caps(c) if c.formats == FORMAT_TEXT));
    assert_eq!(replies[1], ExtMsg::Request(FORMAT_TEXT));
    assert_eq!(replies.len(), 2);
}

#[tokio::test]
async fn without_the_extension_the_decoder_never_replies() {
    // Legacy text only; no pseudo-encoding advertised.
    let bytes = vec![3, 0, 0, 0, 0, 0, 0, 2, b'h', b'i'];
    let (events, replies) = run_loop(&bytes, &[VncEncoding::Raw]).await;
    assert!(matches!(events.as_slice(), [VncEvent::Text(t)] if t == "hi"));
    assert!(replies.is_empty());
}

// ------------------------------------------------ the real client, end to end --

fn server_init() -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&16u16.to_be_bytes());
    v.extend_from_slice(&16u16.to_be_bytes());
    v.extend(<PixelFormat as Into<Vec<u8>>>::into(PixelFormat::rgba()));
    v.extend_from_slice(&4_u32.to_be_bytes());
    v.extend_from_slice(b"test");
    v
}

/// Connect a real client with `encodings`; returns it, the server end, and the
/// encoding numbers the client sent in `SetEncodings`.
async fn connect(encodings: Vec<VncEncoding>) -> (VncClient, DuplexStream, Vec<i32>) {
    let (client_io, mut server) = tokio::io::duplex(1 << 16);
    let connect = tokio::spawn(VncClient::with_event_budget(
        client_io,
        Some(PixelFormat::rgba()),
        encodings,
        1 << 20,
    ));
    let mut shared_flag = [0; 1];
    server.read_exact(&mut shared_flag).await.unwrap();
    server.write_all(&server_init()).await.unwrap();
    let client = tokio::time::timeout(Duration::from_secs(5), connect)
        .await
        .expect("connect must not hang")
        .unwrap()
        .unwrap();
    let mut set_pixel_format = [0; 20];
    server.read_exact(&mut set_pixel_format).await.unwrap();
    let mut header = [0; 4];
    server.read_exact(&mut header).await.unwrap();
    assert_eq!(header[0], 2, "SetEncodings");
    let count = u16::from_be_bytes([header[2], header[3]]);
    let mut sent = Vec::new();
    for _ in 0..count {
        sent.push(server.read_i32().await.unwrap());
    }
    let mut fbur = [0; 10];
    server.read_exact(&mut fbur).await.unwrap();
    (client, server, sent)
}

/// Read one extended `ClientCutText` off the server end.
async fn read_client_ext(server: &mut DuplexStream) -> ExtMsg {
    let mut header = [0; 8];
    tokio::time::timeout(Duration::from_secs(5), server.read_exact(&mut header))
        .await
        .expect("client message")
        .unwrap();
    assert_eq!(header[0], 6, "ClientCutText");
    let len = i32::from_be_bytes(header[4..8].try_into().unwrap());
    assert!(len < 0, "expected the extended form, got length {len}");
    let mut payload = vec![0; len.unsigned_abs() as usize];
    server.read_exact(&mut payload).await.unwrap();
    parse(&payload, TEXT_AND_DIB).unwrap()
}

async fn next_event(client: &VncClient) -> VncEvent {
    tokio::time::timeout(Duration::from_secs(5), client.recv_event())
        .await
        .expect("event")
        .unwrap()
}

#[tokio::test]
async fn a_client_negotiates_the_extension_and_sends_utf8_losslessly() {
    let (client, mut server, sent) = connect(vec![
        VncEncoding::Raw,
        VncEncoding::ExtendedClipboardPseudo { images: true },
    ])
    .await;
    assert!(sent.contains(&ENCODING_EXTENDED_CLIPBOARD));

    // The server announces text + dib; the client answers with its caps.
    let server_caps = caps(
        FORMAT_TEXT | FORMAT_DIB,
        ACTION_CAPS | ACTION_REQUEST | ACTION_PEEK | ACTION_NOTIFY | ACTION_PROVIDE,
        &[(FORMAT_TEXT, 1 << 20), (FORMAT_DIB, 1 << 20)],
    );
    server
        .write_all(&server_ext(&encode_payload(&ExtMsg::Caps(server_caps))))
        .await
        .unwrap();
    let ExtMsg::Caps(reply) = read_client_ext(&mut server).await else {
        panic!("expected client caps");
    };
    assert_eq!(reply.formats, TEXT_AND_DIB);
    loop {
        match next_event(&client).await {
            VncEvent::ClipboardCapabilities(c) => {
                assert_eq!(c, ClipboardCapabilities { text: true, images: true });
                break;
            }
            VncEvent::SetResolution(_) => {}
            other => panic!("unexpected event {other:?}"),
        }
    }

    // Non-Latin-1 text now goes out as UTF-8 through `provide`.
    client
        .input(X11Event::CopyText("日本 🎉\nzwei".to_string()))
        .await
        .unwrap();
    let ExtMsg::Provide(p) = read_client_ext(&mut server).await else {
        panic!("expected provide");
    };
    assert_eq!(p.items.len(), 1);
    assert_eq!(p.items[0].0, FORMAT_TEXT);
    assert_eq!(decode_text(p.items[0].1.clone()), "日本 🎉\nzwei");

    // And an image as a dib.
    client.input(X11Event::CopyDib(vec![40, 0, 0, 0])).await.unwrap();
    assert_eq!(
        read_client_ext(&mut server).await,
        provide(vec![(FORMAT_DIB, vec![40, 0, 0, 0])])
    );

    // A server provide arrives as a dib event.
    server
        .write_all(&server_ext(&provide_payload(
            FORMAT_DIB,
            &[(3, Part::Bytes(vec![7, 8, 9]))],
        )))
        .await
        .unwrap();
    assert!(matches!(next_event(&client).await, VncEvent::ClipboardDib(d) if d == [7, 8, 9]));
    client.close().await.unwrap();
}

#[tokio::test]
async fn a_client_on_a_server_without_the_extension_stays_on_the_legacy_path() {
    let (client, mut server, sent) = connect(vec![
        VncEncoding::Raw,
        VncEncoding::ExtendedClipboardPseudo { images: true },
    ])
    .await;
    assert!(sent.contains(&ENCODING_EXTENDED_CLIPBOARD));
    // No caps from the server: text goes out as a legacy ClientCutText.
    client.input(X11Event::CopyText("café".to_string())).await.unwrap();
    let mut msg = [0; 12];
    server.read_exact(&mut msg).await.unwrap();
    assert_eq!(msg, [6, 0, 0, 0, 0, 0, 0, 4, b'c', b'a', b'f', 0xE9]);
    // And an image has nowhere to go.
    assert!(client.input(X11Event::CopyDib(vec![1])).await.is_err());
    client.close().await.unwrap();
}

#[tokio::test]
async fn a_client_that_does_not_opt_in_never_advertises_the_extension() {
    let (client, mut server, sent) = connect(vec![VncEncoding::Raw]).await;
    assert!(!sent.contains(&ENCODING_EXTENDED_CLIPBOARD));
    client.input(X11Event::CopyText("日本".to_string())).await.unwrap();
    let mut header = [0; 8];
    server.read_exact(&mut header).await.unwrap();
    assert_eq!(&header[..4], &[6, 0, 0, 0]);
    assert_eq!(u32::from_be_bytes(header[4..8].try_into().unwrap()), 6);
    client.close().await.unwrap();
}
