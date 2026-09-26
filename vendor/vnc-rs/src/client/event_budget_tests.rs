//! termiHub fork (#3511): a hostile server must not be able to make the client
//! queue more decoded bytes than the event budget, however small its wire
//! payload is. Each test drives the real client (decoder + connection tasks)
//! over an in-memory duplex "server".

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

use super::VncClient;
use crate::{PixelFormat, VncEncoding, VncEvent};

/// A small budget so the flood stays cheap: four 256 x 256 RGBA rectangles.
const BUDGET: usize = 1 << 20;
const SIDE: u16 = 256;
const RECT_BYTES: usize = SIDE as usize * SIDE as usize * 4;
/// 16 MiB of decoded pixels from about 1 KiB of wire bytes.
const RECTS: u16 = 64;
const TIGHT: i32 = 7;
const BELL: u8 = 2;

fn server_init(w: u16, h: u16) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&w.to_be_bytes());
    v.extend_from_slice(&h.to_be_bytes());
    v.extend(<PixelFormat as Into<Vec<u8>>>::into(PixelFormat::rgba()));
    v.extend_from_slice(&4_u32.to_be_bytes());
    v.extend_from_slice(b"test");
    v
}

/// One `FramebufferUpdate` of `rects` Tight fill rectangles: 16 wire bytes
/// each, decoding to `RECT_BYTES` of pixels each. Followed by a Bell marker.
fn tight_fill_flood(rects: u16) -> Vec<u8> {
    let mut v = vec![0, 0];
    v.extend_from_slice(&rects.to_be_bytes());
    for _ in 0..rects {
        for n in [0, 0, SIDE, SIDE] {
            v.extend_from_slice(&n.to_be_bytes());
        }
        v.extend_from_slice(&TIGHT.to_be_bytes());
        v.push(0x80); // Tight fill
        v.extend_from_slice(&[0x11, 0x22, 0x33]);
    }
    v.push(BELL);
    v
}

/// Connect a client (post-security) with `budget`, then send `flood`. The
/// returned server handle keeps the connection open.
async fn flooded_client(budget: usize, flood: Vec<u8>) -> (VncClient, DuplexStream) {
    let (client_io, mut server) = tokio::io::duplex(1 << 16);
    let connect = tokio::spawn(VncClient::with_event_budget(
        client_io,
        Some(PixelFormat::rgba()),
        vec![VncEncoding::Tight],
        budget,
    ));
    let mut shared_flag = [0; 1];
    server.read_exact(&mut shared_flag).await.unwrap(); // ClientInit
    server.write_all(&server_init(SIDE, SIDE)).await.unwrap();
    let client = tokio::time::timeout(Duration::from_secs(5), connect)
        .await
        .expect("connect must not hang")
        .unwrap()
        .unwrap();
    server.write_all(&flood).await.unwrap();
    (client, server)
}

/// Poll once and classify the event (`None` when the queue is empty).
async fn poll(client: &VncClient) -> Option<VncEvent> {
    client.poll_event().await.expect("client still running")
}

#[tokio::test]
async fn a_decompression_flood_is_held_to_the_byte_budget_and_drains_completely() {
    let (client, _server) = flooded_client(BUDGET, tight_fill_flood(RECTS)).await;

    // Nobody drains: the decoder fills the budget, then parks.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let queued = client.queued_event_bytes().await;
    assert!(
        queued <= BUDGET,
        "queued {queued} bytes over budget {BUDGET}"
    );
    assert!(
        queued > BUDGET - RECT_BYTES,
        "the decoder should have filled the budget, queued {queued}"
    );

    // Draining releases the decoder; every rectangle arrives, in order, with
    // the budget respected throughout.
    let mut images = 0;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let queued = client.queued_event_bytes().await;
        assert!(
            queued <= BUDGET,
            "queued {queued} bytes over budget {BUDGET}"
        );
        match poll(&client).await {
            Some(VncEvent::RawImage(_, data)) => {
                assert_eq!(data.len(), RECT_BYTES);
                images += 1;
            }
            Some(VncEvent::Bell) => break,
            Some(_) => {}
            None => {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "stalled after {images} images"
                );
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        }
    }
    assert_eq!(images, usize::from(RECTS), "no rectangle may be dropped");
    assert_eq!(client.queued_event_bytes().await, 0);
}

#[tokio::test]
async fn an_image_larger_than_the_budget_is_delivered() {
    let (client, _server) = flooded_client(RECT_BYTES / 4, tight_fill_flood(3)).await;
    let mut images = 0;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        match poll(&client).await {
            Some(VncEvent::RawImage(_, data)) => {
                assert_eq!(data.len(), RECT_BYTES);
                images += 1;
            }
            Some(VncEvent::Bell) => break,
            Some(_) => {}
            None => {
                assert!(tokio::time::Instant::now() < deadline, "stalled");
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        }
    }
    assert_eq!(images, 3);
}

#[tokio::test]
async fn close_is_not_blocked_by_a_decoder_parked_on_the_budget() {
    let (client, mut server) = flooded_client(BUDGET, tight_fill_flood(RECTS)).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        client.queued_event_bytes().await > 0,
        "decoder should be parked"
    );

    tokio::time::timeout(Duration::from_secs(5), client.close())
        .await
        .expect("close must not wait on a parked decoder")
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), client.poll_event())
        .await
        .expect("poll_event must not hang after close")
        .ok();

    // The connection task shuts down and releases the socket.
    let mut sink = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), server.read_to_end(&mut sink))
        .await
        .expect("the client must release the connection after close")
        .unwrap();
}
