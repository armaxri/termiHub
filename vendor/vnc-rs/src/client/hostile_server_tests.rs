//! termiHub fork (#3473): a hostile or buggy VNC server must never be able to
//! panic the client. Every test here feeds crafted server bytes into the real
//! message parser / decoding loop and asserts a clean result or a typed error.

use std::io::Write;
use std::sync::Mutex;

use tokio::sync::oneshot;

use super::connection::asycn_vnc_read_loop;
use super::messages::ServerMsg;
use crate::{PixelFormat, VncEncoding, VncError, VncEvent};

/// Every encoding the decoder implements — what `run` treats as negotiated.
const ALL_ENCODINGS: [VncEncoding; 8] = [
    VncEncoding::Raw,
    VncEncoding::CopyRect,
    VncEncoding::Tight,
    VncEncoding::Trle,
    VncEncoding::Zrle,
    VncEncoding::CursorPseudo,
    VncEncoding::DesktopSizePseudo,
    VncEncoding::LastRectPseudo,
];

/// Encoding numbers on the wire.
const RAW: i32 = 0;
const COPY_RECT: i32 = 1;
const TIGHT: i32 = 7;
const TRLE: i32 = 15;
const ZRLE: i32 = 16;
const CURSOR: i32 = -239;

/// A `FramebufferUpdate` header announcing `rects` rectangles.
fn fb_update(rects: u16) -> Vec<u8> {
    let mut v = vec![0, 0];
    v.extend_from_slice(&rects.to_be_bytes());
    v
}

/// A rectangle header.
fn rect(x: u16, y: u16, w: u16, h: u16, encoding: i32) -> Vec<u8> {
    let mut v = Vec::new();
    for n in [x, y, w, h] {
        v.extend_from_slice(&n.to_be_bytes());
    }
    v.extend_from_slice(&encoding.to_be_bytes());
    v
}

const BELL: u8 = 2;

fn zlib(data: &[u8]) -> Vec<u8> {
    let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
    enc.write_all(data).unwrap();
    enc.flush().unwrap();
    // A sync-flushed (not finished) stream, as ZRLE servers send it.
    enc.get_ref().clone()
}

/// Run the real decoding loop over `bytes` with pixel format `pf`, returning
/// the loop's result and every event it emitted. A panic fails the test.
///
/// Every encoding counts as negotiated and the framebuffer is the full 16-bit
/// space, so the per-rectangle checks exercised are the decoders' own; see
/// [`run_with`] for the negotiation / on-screen checks (#3499).
async fn run(bytes: &[u8], pf: &PixelFormat) -> (Result<(), VncError>, Vec<VncEvent>) {
    run_with(bytes, pf, &ALL_ENCODINGS, (u16::MAX, u16::MAX)).await
}

/// [`run`] with an explicit negotiated-encoding list and framebuffer size.
async fn run_with(
    bytes: &[u8],
    pf: &PixelFormat,
    encodings: &[VncEncoding],
    screen: (u16, u16),
) -> (Result<(), VncError>, Vec<VncEvent>) {
    let events = Mutex::new(Vec::new());
    let output = |e: VncEvent| {
        events.lock().unwrap().push(e);
        std::future::ready(Ok::<(), VncError>(()))
    };
    let (_stop_tx, mut stop_rx) = oneshot::channel();
    let mut reader = bytes;
    let result =
        asycn_vnc_read_loop(&mut reader, pf, &output, &mut stop_rx, encodings, screen).await;
    (result, events.into_inner().unwrap())
}

fn is_eof(r: &Result<(), VncError>) -> bool {
    matches!(r, Err(VncError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof)
}

fn has_bell(events: &[VncEvent]) -> bool {
    events.iter().any(|e| matches!(e, VncEvent::Bell))
}

fn pf_16bpp() -> PixelFormat {
    let mut pf = PixelFormat::rgba();
    pf.bits_per_pixel = 16;
    pf.depth = 16;
    pf.red_max = 31;
    pf.green_max = 63;
    pf.blue_max = 31;
    pf.red_shift = 11;
    pf.green_shift = 5;
    pf.blue_shift = 0;
    pf
}

// ---------------------------------------------------------------- messages --

#[tokio::test]
async fn set_color_map_entries_is_consumed_and_stream_stays_in_sync() {
    // SetColorMapEntries: type 1, padding, first-color 0, 2 colours x 6 bytes,
    // then a Bell.
    let mut bytes = vec![1, 0, 0, 0, 0, 2];
    bytes.extend_from_slice(&[0xAA; 12]);
    bytes.push(BELL);
    let mut reader = bytes.as_slice();
    assert!(matches!(
        ServerMsg::read(&mut reader).await.unwrap(),
        ServerMsg::SetColorMapEntries(0, 2)
    ));
    assert!(matches!(
        ServerMsg::read(&mut reader).await.unwrap(),
        ServerMsg::Bell
    ));
}

#[tokio::test]
async fn set_color_map_entries_in_the_read_loop_does_not_panic() {
    let mut bytes = vec![1, 0, 0, 5, 0xFF, 0xFF];
    bytes.extend_from_slice(&vec![0; 0xFFFF * 6]);
    bytes.push(BELL);
    let (result, events) = run(&bytes, &PixelFormat::rgba()).await;
    assert!(is_eof(&result), "{result:?}");
    assert!(has_bell(&events));
}

#[tokio::test]
async fn truncated_set_color_map_entries_is_an_error() {
    let bytes = [1, 0, 0, 0, 0xFF, 0xFF, 1, 2, 3];
    assert!(ServerMsg::read(&mut bytes.as_slice()).await.is_err());
}

#[tokio::test]
async fn unknown_server_message_is_an_error() {
    let (result, _) = run(&[200], &PixelFormat::rgba()).await;
    assert!(matches!(result, Err(VncError::WrongServerMessage)));
}

// ---------------------------------------------------------- rect geometry --

#[tokio::test]
async fn oversize_raw_rect_is_rejected_before_allocating() {
    let mut bytes = fb_update(1);
    bytes.extend(rect(0, 0, u16::MAX, u16::MAX, RAW));
    let (result, _) = run(&bytes, &PixelFormat::rgba()).await;
    assert!(matches!(result, Err(VncError::Protocol(_))), "{result:?}");
}

#[tokio::test]
async fn rect_overflowing_coordinate_space_is_rejected() {
    for enc in [RAW, COPY_RECT, TIGHT, TRLE, ZRLE] {
        let mut bytes = fb_update(1);
        bytes.extend(rect(u16::MAX - 1, 0, 16, 1, enc));
        let (result, _) = run(&bytes, &PixelFormat::rgba()).await;
        assert!(
            matches!(result, Err(VncError::Protocol(_))),
            "{enc}: {result:?}"
        );
    }
}

#[tokio::test]
async fn copy_rect_with_overflowing_source_is_rejected() {
    let mut bytes = fb_update(1);
    bytes.extend(rect(0, 0, 16, 16, COPY_RECT));
    bytes.extend_from_slice(&u16::MAX.to_be_bytes());
    bytes.extend_from_slice(&0_u16.to_be_bytes());
    let (result, _) = run(&bytes, &PixelFormat::rgba()).await;
    assert!(matches!(result, Err(VncError::Protocol(_))), "{result:?}");
}

#[tokio::test]
async fn unknown_encoding_is_a_typed_error() {
    let mut bytes = fb_update(1);
    bytes.extend(rect(0, 0, 1, 1, 5)); // Hextile — never negotiated
    let (result, _) = run(&bytes, &PixelFormat::rgba()).await;
    assert!(
        matches!(result, Err(VncError::UnsupportedEncoding(5))),
        "{result:?}"
    );
}

#[tokio::test]
async fn truncated_raw_rect_is_an_eof_error() {
    let mut bytes = fb_update(1);
    bytes.extend(rect(0, 0, 4, 4, RAW));
    bytes.extend_from_slice(&[0; 10]);
    let (result, _) = run(&bytes, &PixelFormat::rgba()).await;
    assert!(is_eof(&result), "{result:?}");
}

// ------------------------------------ negotiation and framebuffer (#3499) --
// Ported from vnc-rs 0.6.0 (upstream 623b894 / dea233d).

#[tokio::test]
async fn rect_outside_the_framebuffer_is_rejected() {
    for enc in [RAW, COPY_RECT, TIGHT, TRLE, ZRLE] {
        let mut bytes = fb_update(1);
        bytes.extend(rect(630, 0, 16, 1, enc));
        let (result, _) = run_with(&bytes, &PixelFormat::rgba(), &ALL_ENCODINGS, (640, 480)).await;
        assert!(
            matches!(result, Err(VncError::Protocol(_))),
            "{enc}: {result:?}"
        );
    }
}

#[tokio::test]
async fn rect_on_the_framebuffer_edge_still_decodes() {
    let mut bytes = fb_update(1);
    bytes.extend(rect(638, 479, 2, 1, RAW));
    bytes.extend_from_slice(&[0; 8]);
    bytes.push(BELL);
    let (result, events) = run_with(&bytes, &PixelFormat::rgba(), &ALL_ENCODINGS, (640, 480)).await;
    assert!(is_eof(&result), "{result:?}");
    assert!(events.iter().any(|e| matches!(e, VncEvent::RawImage(..))));
    assert!(has_bell(&events));
}

#[tokio::test]
async fn copy_rect_source_outside_the_framebuffer_is_rejected() {
    let mut bytes = fb_update(1);
    bytes.extend(rect(0, 0, 16, 16, COPY_RECT));
    bytes.extend_from_slice(&630_u16.to_be_bytes());
    bytes.extend_from_slice(&0_u16.to_be_bytes());
    let (result, _) = run_with(&bytes, &PixelFormat::rgba(), &ALL_ENCODINGS, (640, 480)).await;
    assert!(matches!(result, Err(VncError::Protocol(_))), "{result:?}");
}

#[tokio::test]
async fn encoding_the_client_did_not_negotiate_is_rejected() {
    let negotiated = [VncEncoding::Raw, VncEncoding::Zrle];
    for enc in [COPY_RECT, TIGHT, TRLE, CURSOR] {
        let mut bytes = fb_update(1);
        bytes.extend(rect(0, 0, 1, 1, enc));
        let (result, _) = run_with(&bytes, &PixelFormat::rgba(), &negotiated, (640, 480)).await;
        assert!(
            matches!(result, Err(VncError::Protocol(_))),
            "{enc}: {result:?}"
        );
    }
    // Raw is always allowed, even when not listed.
    let mut bytes = fb_update(1);
    bytes.extend(rect(0, 0, 1, 1, RAW));
    bytes.extend_from_slice(&[0; 4]);
    let (result, _) = run_with(
        &bytes,
        &PixelFormat::rgba(),
        &[VncEncoding::Zrle],
        (640, 480),
    )
    .await;
    assert!(is_eof(&result), "{result:?}");
}

#[tokio::test]
async fn desktop_size_grows_the_framebuffer_for_later_rects() {
    let mut bytes = fb_update(2);
    bytes.extend(rect(0, 0, 1024, 768, -223));
    bytes.extend(rect(1000, 700, 2, 1, RAW));
    bytes.extend_from_slice(&[0; 8]);
    let (result, events) = run_with(&bytes, &PixelFormat::rgba(), &ALL_ENCODINGS, (640, 480)).await;
    assert!(is_eof(&result), "{result:?}");
    assert!(events.iter().any(|e| matches!(e, VncEvent::RawImage(..))));
}

#[tokio::test]
async fn desktop_size_shrink_rejects_rects_beyond_the_new_edge() {
    let mut bytes = fb_update(2);
    bytes.extend(rect(0, 0, 320, 200, -223));
    bytes.extend(rect(400, 0, 1, 1, RAW));
    let (result, _) = run_with(&bytes, &PixelFormat::rgba(), &ALL_ENCODINGS, (640, 480)).await;
    assert!(matches!(result, Err(VncError::Protocol(_))), "{result:?}");
}

#[tokio::test]
async fn oversize_desktop_size_is_rejected() {
    let mut bytes = fb_update(1);
    bytes.extend(rect(0, 0, 8193, 16, -223));
    let (result, events) = run(&bytes, &PixelFormat::rgba()).await;
    assert!(matches!(result, Err(VncError::Protocol(_))), "{result:?}");
    assert!(!events
        .iter()
        .any(|e| matches!(e, VncEvent::SetResolution(..))));
}

#[tokio::test]
async fn stop_cancels_a_decoder_blocked_mid_message() {
    // A server that sends half a rectangle header and then goes silent: the
    // decoder is parked inside `read_exact`. Upstream only checked the stop
    // signal between messages, so `close()` could not end it.
    let (mut server, mut client) = tokio::io::duplex(64);
    use tokio::io::AsyncWriteExt;
    let mut bytes = fb_update(1);
    bytes.extend_from_slice(&[0, 0, 0, 0]);
    server.write_all(&bytes).await.unwrap();
    let (stop_tx, mut stop_rx) = oneshot::channel();
    let output = |_e: VncEvent| std::future::ready(Ok::<(), VncError>(()));
    let pf = PixelFormat::rgba();
    let decoder = asycn_vnc_read_loop(
        &mut client,
        &pf,
        &output,
        &mut stop_rx,
        &ALL_ENCODINGS,
        (640, 480),
    );
    tokio::pin!(decoder);
    assert!(futures::poll!(decoder.as_mut()).is_pending());
    stop_tx.send(()).unwrap();
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), decoder)
        .await
        .expect("stop must cancel a blocked decoder");
    assert!(result.is_ok(), "{result:?}");
    drop(server);
}

// ------------------------------------------------------------------ cursor --

#[tokio::test]
async fn cursor_in_16bpp_is_skipped_and_stream_stays_in_sync() {
    // Upstream hit `unreachable!()` (and out-of-bounds writes) for this.
    let pf = pf_16bpp();
    let mut bytes = fb_update(1);
    bytes.extend(rect(1, 1, 3, 2, CURSOR));
    bytes.extend_from_slice(&[0x55; 3 * 2 * 2]); // pixels, 2 bytes each
    bytes.extend_from_slice(&[0xFF; 2]); // mask: 1 byte per row
    bytes.push(BELL);
    let (result, events) = run(&bytes, &pf).await;
    assert!(is_eof(&result), "{result:?}");
    assert!(has_bell(&events), "stream desynchronised");
    assert!(!events.iter().any(|e| matches!(e, VncEvent::SetCursor(..))));
}

#[tokio::test]
async fn cursor_with_out_of_range_shifts_is_skipped() {
    let mut pf = PixelFormat::rgba();
    pf.red_shift = 200;
    let mut bytes = fb_update(1);
    bytes.extend(rect(0, 0, 2, 1, CURSOR));
    bytes.extend_from_slice(&[0; 8]);
    bytes.push(0xC0);
    bytes.push(BELL);
    let (result, events) = run(&bytes, &pf).await;
    assert!(is_eof(&result), "{result:?}");
    assert!(has_bell(&events));
}

#[tokio::test]
async fn cursor_in_rgba_still_decodes_with_mask_alpha() {
    let mut bytes = fb_update(1);
    bytes.extend(rect(0, 0, 2, 1, CURSOR));
    bytes.extend_from_slice(&[1, 2, 3, 9, 4, 5, 6, 9]);
    bytes.push(0x80); // first pixel opaque, second transparent
    let (_, events) = run(&bytes, &PixelFormat::rgba()).await;
    let cursor = events.iter().find_map(|e| match e {
        VncEvent::SetCursor(_, data) => Some(data.clone()),
        _ => None,
    });
    assert_eq!(cursor.unwrap(), vec![1, 2, 3, 255, 4, 5, 6, 0]);
}

// ------------------------------------------------------------------- tight --

#[tokio::test]
async fn tight_in_16bpp_is_a_typed_error_not_a_panic() {
    let mut bytes = fb_update(1);
    bytes.extend(rect(0, 0, 1, 1, TIGHT));
    bytes.push(0x80); // fill
    bytes.extend_from_slice(&[1, 2, 3]);
    let (result, _) = run(&bytes, &pf_16bpp()).await;
    assert!(
        matches!(result, Err(VncError::WrongPixelFormat)),
        "{result:?}"
    );
}

#[tokio::test]
async fn tight_palette_index_out_of_range_is_invalid_data() {
    let mut bytes = fb_update(1);
    bytes.extend(rect(0, 0, 2, 1, TIGHT));
    bytes.push(0x40); // basic rect, stream 0, explicit filter
    bytes.push(1); // palette filter
    bytes.push(2); // 3 colours
    bytes.extend_from_slice(&[0; 9]);
    bytes.extend_from_slice(&[0, 5]); // raw (< 12 bytes) indexes; 5 is out of range
    let (result, _) = run(&bytes, &PixelFormat::rgba()).await;
    assert!(
        matches!(result, Err(VncError::InvalidImageData)),
        "{result:?}"
    );
}

#[tokio::test]
async fn tight_single_colour_palette_uses_byte_indexes() {
    // Upstream bit-packed a one-colour palette and then indexed it per pixel,
    // reading past the data.
    let mut bytes = fb_update(1);
    bytes.extend(rect(0, 0, 4, 1, TIGHT));
    bytes.push(0x40);
    bytes.push(1);
    bytes.push(0); // 1 colour
    bytes.extend_from_slice(&[10, 20, 30]);
    bytes.extend_from_slice(&[0; 4]);
    let (result, events) = run(&bytes, &PixelFormat::rgba()).await;
    assert!(is_eof(&result), "{result:?}");
    let image = events.iter().find_map(|e| match e {
        VncEvent::RawImage(_, data) => Some(data.clone()),
        _ => None,
    });
    assert_eq!(image.unwrap(), [10, 20, 30, 255].repeat(4));
}

#[tokio::test]
async fn tight_after_failed_zlib_decode_errors_instead_of_panicking() {
    // A copy-filter rect of >= 12 bytes with garbage zlib data fails and
    // consumes stream 0's decompressor; the error ends the loop cleanly.
    let mut bytes = fb_update(2);
    bytes.extend(rect(0, 0, 4, 1, TIGHT));
    bytes.push(0x00); // basic, stream 0, copy filter
    bytes.push(3); // compact length 3
    bytes.extend_from_slice(&[0xDE, 0xAD, 0xBE]);
    let (result, _) = run(&bytes, &PixelFormat::rgba()).await;
    assert!(result.is_err());
}

// ------------------------------------------------------------- zrle / trle --

#[tokio::test]
async fn zrle_rle_run_overshooting_the_tile_is_invalid_data() {
    // 1x1 tile, true-colour RLE: one pixel with a run of 201.
    let payload = zlib(&[0x80, 1, 2, 3, 200]);
    let mut bytes = fb_update(1);
    bytes.extend(rect(0, 0, 1, 1, ZRLE));
    bytes.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    bytes.extend(payload);
    let (result, _) = run(&bytes, &PixelFormat::rgba()).await;
    assert!(
        matches!(result, Err(VncError::InvalidImageData)),
        "{result:?}"
    );
}

#[tokio::test]
async fn zrle_palette_index_out_of_range_is_invalid_data() {
    // Indexed RLE with a 3-colour palette, then a run of index 100.
    let payload = zlib(&[0x83, 1, 1, 1, 2, 2, 2, 3, 3, 3, 100]);
    let mut bytes = fb_update(1);
    bytes.extend(rect(0, 0, 1, 1, ZRLE));
    bytes.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    bytes.extend(payload);
    let (result, _) = run(&bytes, &PixelFormat::rgba()).await;
    assert!(
        matches!(result, Err(VncError::InvalidImageData)),
        "{result:?}"
    );
}

#[tokio::test]
async fn zrle_oversize_length_prefix_is_rejected_before_allocating() {
    let mut bytes = fb_update(1);
    bytes.extend(rect(0, 0, 1, 1, ZRLE));
    bytes.extend_from_slice(&u32::MAX.to_be_bytes());
    let (result, _) = run(&bytes, &PixelFormat::rgba()).await;
    assert!(matches!(result, Err(VncError::Protocol(_))), "{result:?}");
}

#[tokio::test]
async fn zrle_rect_of_65535_rows_does_not_overflow_the_tile_cursor() {
    // Upstream computed `y + 64 > height` in u16, overflowing at the last
    // tile row of a 65535-row rectangle.
    let mut tiles = Vec::new();
    for _ in 0..65535_usize.div_ceil(64) {
        tiles.extend_from_slice(&[1, 9, 9, 9]); // solid-colour tile
    }
    let payload = zlib(&tiles);
    let mut bytes = fb_update(1);
    bytes.extend(rect(0, 0, 1, u16::MAX, ZRLE));
    bytes.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    bytes.extend(payload);
    bytes.push(BELL);
    let (result, events) = run(&bytes, &PixelFormat::rgba()).await;
    assert!(is_eof(&result), "{result:?}");
    assert!(has_bell(&events));
}

#[tokio::test]
async fn trle_rect_of_65535_rows_does_not_overflow_the_tile_cursor() {
    let mut bytes = fb_update(1);
    bytes.extend(rect(0, 0, 1, u16::MAX, TRLE));
    // TRLE has no length prefix and uses 16-row tiles (#3478).
    for _ in 0..65535_usize.div_ceil(16) {
        bytes.extend_from_slice(&[1, 9, 9, 9]);
    }
    bytes.push(BELL);
    let (result, events) = run(&bytes, &PixelFormat::rgba()).await;
    assert!(is_eof(&result), "{result:?}");
    assert!(has_bell(&events));
}

#[tokio::test]
async fn trle_palette_index_out_of_range_is_invalid_data() {
    let mut bytes = fb_update(1);
    bytes.extend(rect(0, 0, 2, 1, TRLE));
    // Indexed RLE, 2-colour palette, then index 50.
    bytes.extend_from_slice(&[0x82, 1, 1, 1, 2, 2, 2, 50]);
    let (result, _) = run(&bytes, &PixelFormat::rgba()).await;
    assert!(
        matches!(result, Err(VncError::InvalidImageData)),
        "{result:?}"
    );
}

// ------------------------------------------------------------------- fuzz --

/// Deterministic xorshift64* so the property test is reproducible.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn noise(&mut self, max_len: u64) -> Vec<u8> {
        let n = self.below(max_len) as usize;
        self.bytes(n)
    }
    fn bytes(&mut self, n: usize) -> Vec<u8> {
        (0..n).map(|_| self.next() as u8).collect()
    }
}

/// A plausible-but-hostile server stream: real message and rectangle headers
/// (so the decoders are actually reached) with random geometry, encodings and
/// payload bytes.
fn hostile_stream(rng: &mut Rng) -> Vec<u8> {
    const ENCODINGS: [i32; 10] = [RAW, COPY_RECT, TIGHT, TRLE, ZRLE, CURSOR, -223, -224, 5, 2];
    let mut out = Vec::new();
    for _ in 0..rng.below(4) + 1 {
        match rng.below(5) {
            0 | 1 => {
                let n = rng.below(3) as u16 + 1;
                out.extend(fb_update(n));
                for _ in 0..n {
                    // Mostly small; sometimes a hostile edge value. Any two
                    // edge values multiply past the area cap, so the fuzz never
                    // legitimately decodes a giant rectangle (keeps it fast).
                    let dim = |r: &mut Rng| {
                        if r.below(8) == 0 {
                            [8193, 32768, u16::MAX - 1, u16::MAX][r.below(4) as usize]
                        } else {
                            r.below(20) as u16
                        }
                    };
                    let (x, y, w, h) = (dim(rng), dim(rng), dim(rng), dim(rng));
                    let enc = ENCODINGS[rng.below(ENCODINGS.len() as u64) as usize];
                    out.extend(rect(x, y, w, h, enc));
                    if enc == ZRLE && rng.below(2) == 0 {
                        let inner = rng.noise(64);
                        let z = zlib(&inner);
                        out.extend_from_slice(&(z.len() as u32).to_be_bytes());
                        out.extend(z);
                    } else {
                        let n = rng.below(96) as usize;
                        out.extend(rng.bytes(n));
                    }
                }
            }
            2 => {
                out.extend_from_slice(&[1, 0, 0, 0]);
                let n = rng.below(8) as u16;
                out.extend_from_slice(&n.to_be_bytes());
                out.extend(rng.noise(60));
            }
            3 => out.push(BELL),
            _ => out.extend(rng.noise(32)),
        }
    }
    out
}

#[tokio::test]
async fn random_server_streams_never_panic_the_decoder() {
    let formats = [PixelFormat::rgba(), PixelFormat::bgra(), pf_16bpp(), {
        let mut pf = PixelFormat::rgba();
        pf.bits_per_pixel = 8;
        pf.red_shift = 250;
        pf.green_max = u16::MAX;
        pf
    }];
    let mut rng = Rng(0x3473_5EED_0BAD_F00D);
    for i in 0..3000 {
        let stream = hostile_stream(&mut rng);
        let pf = &formats[i % formats.len()];
        // Any Ok/Err is fine; a panic fails the test.
        let _ = run(&stream, pf).await;
    }
    // The same streams against a small framebuffer and a narrow negotiated
    // encoding list, so the #3499 negotiation / on-screen checks are fuzzed too.
    let narrow = [
        VncEncoding::Raw,
        VncEncoding::Zrle,
        VncEncoding::DesktopSizePseudo,
    ];
    for _ in 0..1000 {
        let stream = hostile_stream(&mut rng);
        let _ = run_with(&stream, &PixelFormat::rgba(), &narrow, (16, 16)).await;
    }
    // Pure noise too.
    for _ in 0..2000 {
        let len = rng.below(256) as usize;
        let stream = rng.bytes(len);
        let _ = run(&stream, &PixelFormat::rgba()).await;
    }
}
