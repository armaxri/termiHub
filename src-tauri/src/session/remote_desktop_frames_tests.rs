use super::*;

use std::sync::Mutex as StdMutex;

use termihub_core::connection::{CursorShape, DirtyRect};

fn u32_at(buf: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(buf[offset..offset + 4].try_into().unwrap())
}

fn rect(x: u32, y: u32, width: u32, height: u32, fill: u8) -> DirtyRect {
    DirtyRect {
        x,
        y,
        width,
        height,
        data: vec![fill; (width * height * 4) as usize],
    }
}

#[test]
fn frame_encodes_header_then_each_rect_and_its_payload() {
    let frame = FrameUpdate {
        width: 640,
        height: 480,
        rects: vec![rect(10, 20, 2, 1, 0xAB), rect(0, 0, 1, 1, 0x07)],
    };
    let buf = encode_frame(&frame);

    assert_eq!(&buf[..4], &[KIND_FRAME, WIRE_VERSION, 0, 0]);
    assert_eq!(u32_at(&buf, 4), 640);
    assert_eq!(u32_at(&buf, 8), 480);
    assert_eq!(u32_at(&buf, 12), 2);

    let r0 = FRAME_HEADER_LEN;
    assert_eq!(
        [
            u32_at(&buf, r0),
            u32_at(&buf, r0 + 4),
            u32_at(&buf, r0 + 8),
            u32_at(&buf, r0 + 12)
        ],
        [10, 20, 2, 1]
    );
    let p0 = r0 + RECT_HEADER_LEN;
    assert_eq!(&buf[p0..p0 + 8], &[0xAB; 8]);

    let r1 = p0 + 8;
    assert_eq!(
        [
            u32_at(&buf, r1),
            u32_at(&buf, r1 + 4),
            u32_at(&buf, r1 + 8),
            u32_at(&buf, r1 + 12)
        ],
        [0, 0, 1, 1]
    );
    let p1 = r1 + RECT_HEADER_LEN;
    assert_eq!(&buf[p1..], &[0x07; 4]);
}

#[test]
fn empty_frame_is_just_the_header() {
    let buf = encode_frame(&FrameUpdate {
        width: 8,
        height: 8,
        rects: vec![],
    });
    assert_eq!(buf.len(), FRAME_HEADER_LEN);
    assert_eq!(u32_at(&buf, 12), 0);
}

#[test]
fn malformed_rect_is_skipped_so_later_rects_stay_aligned() {
    let mut bad = rect(0, 0, 2, 2, 0x11);
    bad.data.truncate(3);
    let frame = FrameUpdate {
        width: 8,
        height: 8,
        rects: vec![bad, rect(4, 4, 1, 1, 0x22)],
    };
    let buf = encode_frame(&frame);
    assert_eq!(u32_at(&buf, 12), 1);
    assert_eq!(u32_at(&buf, FRAME_HEADER_LEN), 4);
    assert_eq!(buf.len(), FRAME_HEADER_LEN + RECT_HEADER_LEN + 4);
}

/// The point of #4291: a full 1080p frame costs ~1x its RGBA bytes on the
/// wire, where the JSON number array cost several times that.
#[test]
fn full_hd_frame_is_about_one_x_its_pixels_not_four_x() {
    let frame = FrameUpdate {
        width: 1920,
        height: 1080,
        rects: vec![rect(0, 0, 1920, 1080, 0xC8)],
    };
    let pixels = 1920 * 1080 * 4;
    let binary = encode_frame(&frame).len();
    assert_eq!(binary, pixels + FRAME_HEADER_LEN + RECT_HEADER_LEN);
    assert!((binary as f64) / (pixels as f64) < 1.001);

    let json = serde_json::to_vec(&frame).unwrap().len();
    assert!(
        json >= 3 * binary,
        "JSON {json} B vs binary {binary} B — the old encoding should be >=3x"
    );
}

#[test]
fn cursor_with_shape_encodes_flags_position_geometry_and_payload() {
    let cursor = CursorUpdate {
        x: 100,
        y: 200,
        visible: true,
        shape: Some(CursorShape {
            width: 2,
            height: 2,
            hotspot_x: 1,
            hotspot_y: 0,
            data: (0..16).collect(),
        }),
    };
    let buf = encode_cursor(&cursor);
    assert_eq!(
        &buf[..4],
        &[
            KIND_CURSOR,
            WIRE_VERSION,
            CURSOR_FLAG_VISIBLE | CURSOR_FLAG_SHAPE,
            0
        ]
    );
    assert_eq!([u32_at(&buf, 4), u32_at(&buf, 8)], [100, 200]);
    let s = CURSOR_HEADER_LEN;
    assert_eq!(
        [
            u32_at(&buf, s),
            u32_at(&buf, s + 4),
            u32_at(&buf, s + 8),
            u32_at(&buf, s + 12)
        ],
        [2, 2, 1, 0]
    );
    assert_eq!(
        &buf[s + SHAPE_HEADER_LEN..],
        (0..16).collect::<Vec<u8>>().as_slice()
    );
}

#[test]
fn hidden_cursor_without_shape_is_header_and_position_only() {
    let buf = encode_cursor(&CursorUpdate {
        x: 3,
        y: 4,
        visible: false,
        shape: None,
    });
    assert_eq!(buf.len(), CURSOR_HEADER_LEN);
    assert_eq!(buf[2], 0);
    assert_eq!([u32_at(&buf, 4), u32_at(&buf, 8)], [3, 4]);
}

#[test]
fn malformed_cursor_shape_is_left_out() {
    let buf = encode_cursor(&CursorUpdate {
        x: 0,
        y: 0,
        visible: true,
        shape: Some(CursorShape {
            width: 4,
            height: 4,
            hotspot_x: 0,
            hotspot_y: 0,
            data: vec![0; 5],
        }),
    });
    assert_eq!(buf.len(), CURSOR_HEADER_LEN);
    assert_eq!(buf[2], CURSOR_FLAG_VISIBLE);
}

// ── Channel registry ───────────────────────────────────────────────

type Inbox = Arc<StdMutex<Vec<Vec<u8>>>>;

fn recording_sink(alive: bool) -> (FrameSink, Inbox) {
    let inbox: Inbox = Arc::default();
    let rec = Arc::clone(&inbox);
    let sink: FrameSink = Arc::new(move |bytes| {
        rec.lock().unwrap().push(bytes);
        alive
    });
    (sink, inbox)
}

fn received(inbox: &Inbox) -> usize {
    inbox.lock().unwrap().len()
}

#[test]
fn owned_session_reaches_only_the_owning_window() {
    let channels = RemoteDesktopFrameChannels::new();
    let (main_sink, main_inbox) = recording_sink(true);
    let (other_sink, other_inbox) = recording_sink(true);
    channels.subscribe("s1", "main", main_sink);
    channels.subscribe("s1", "win-2", other_sink);

    channels.send(
        "s1",
        &OutputEmitTarget::Window("win-2".into()),
        vec![1, 2, 3],
    );
    assert_eq!(received(&main_inbox), 0);
    assert_eq!(other_inbox.lock().unwrap().as_slice(), &[vec![1, 2, 3]]);
}

#[test]
fn unclaimed_session_is_broadcast_to_every_subscriber() {
    let channels = RemoteDesktopFrameChannels::new();
    let (a, a_inbox) = recording_sink(true);
    let (b, b_inbox) = recording_sink(true);
    channels.subscribe("s1", "main", a);
    channels.subscribe("s1", "win-2", b);
    channels.send("s1", &OutputEmitTarget::Broadcast, vec![9]);
    assert_eq!(received(&a_inbox), 1);
    assert_eq!(received(&b_inbox), 1);
}

#[test]
fn other_sessions_never_receive_the_message() {
    let channels = RemoteDesktopFrameChannels::new();
    let (a, a_inbox) = recording_sink(true);
    channels.subscribe("s2", "main", a);
    channels.send("s1", &OutputEmitTarget::Broadcast, vec![9]);
    assert_eq!(received(&a_inbox), 0);
}

#[test]
fn unsubscribe_and_window_removal_stop_delivery() {
    let channels = RemoteDesktopFrameChannels::new();
    let (a, a_inbox) = recording_sink(true);
    let (b, b_inbox) = recording_sink(true);
    let id = channels.subscribe("s1", "main", a);
    channels.subscribe("s2", "win-2", b);

    assert!(channels.unsubscribe("s1", id));
    assert!(!channels.unsubscribe("s1", id));
    channels.remove_window("win-2");
    channels.send("s1", &OutputEmitTarget::Broadcast, vec![1]);
    channels.send("s2", &OutputEmitTarget::Broadcast, vec![1]);
    assert_eq!(received(&a_inbox), 0);
    assert_eq!(received(&b_inbox), 0);
    assert_eq!(channels.subscriber_count("s1"), 0);
    assert_eq!(channels.subscriber_count("s2"), 0);
}

#[test]
fn a_gone_subscriber_is_pruned_after_a_failed_send() {
    let channels = RemoteDesktopFrameChannels::new();
    let (dead, _) = recording_sink(false);
    let (live, live_inbox) = recording_sink(true);
    channels.subscribe("s1", "main", dead);
    channels.subscribe("s1", "main", live);
    channels.send("s1", &OutputEmitTarget::Broadcast, vec![1]);
    assert_eq!(channels.subscriber_count("s1"), 1);
    channels.send("s1", &OutputEmitTarget::Broadcast, vec![2]);
    assert_eq!(received(&live_inbox), 2);
}

#[test]
fn subscriptions_per_session_are_capped_oldest_first() {
    let channels = RemoteDesktopFrameChannels::new();
    let (first, first_inbox) = recording_sink(true);
    channels.subscribe("s1", "main", first);
    for _ in 0..MAX_SUBSCRIBERS_PER_SESSION {
        let (sink, _) = recording_sink(true);
        channels.subscribe("s1", "main", sink);
    }
    assert_eq!(
        channels.subscriber_count("s1"),
        MAX_SUBSCRIBERS_PER_SESSION
    );
    channels.send("s1", &OutputEmitTarget::Broadcast, vec![1]);
    assert_eq!(received(&first_inbox), 0);
}
