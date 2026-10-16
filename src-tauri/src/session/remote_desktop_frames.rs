//! Binary IPC transport for remote-desktop frames and cursor shapes (#4291).
//!
//! Frame updates used to cross IPC as `remote-desktop-frame` JSON events, where
//! the RGBA payload of every dirty rect became a JSON array with one number per
//! byte: roughly 4x the bytes, plus a large JS number array to copy on the other
//! side (PERF2-001). They now ride a per-session `tauri::ipc::Channel` carrying
//! [`InvokeResponseBody::Raw`](tauri::ipc::InvokeResponseBody::Raw) messages,
//! which the webview receives as an `ArrayBuffer`. Cursor updates (which can
//! carry an RGBA shape) share the same channel, tagged by a message kind.
//!
//! # Wire format (version 2, all integers little-endian `u32` unless noted)
//!
//! Every message starts with a 4-byte header:
//!
//! | offset | size | field                                         |
//! | ------ | ---- | --------------------------------------------- |
//! | 0      | u8   | kind: [`KIND_FRAME`] or [`KIND_CURSOR`]       |
//! | 1      | u8   | version: [`WIRE_VERSION`]                     |
//! | 2      | u8   | flags (cursor only, see below; 0 for frames)  |
//! | 3      | u8   | reserved, 0                                   |
//!
//! **Frame** (`kind = 1`): `width`, `height`, `rect_count` (offset 4..16), then
//! `rect_count` rects, each `x`, `y`, `width`, `height`, `encoding`,
//! `byte_len` (24 bytes) followed by `byte_len` payload bytes, zero-padded to
//! the next multiple of 4. `encoding` is [`RECT_ENCODING_RGBA`] (payload is
//! exactly `width * height * 4` bytes of tightly packed RGBA) or
//! [`RECT_ENCODING_JPEG`] (payload is a baseline JPEG that decodes to exactly
//! `width x height`, #4424). JPEG rects are only sent to a subscriber that
//! opted in (see [`RemoteDesktopFrameChannels::subscribe`]); every other
//! subscriber gets the decoded RGBA of the same rect.
//!
//! **Cursor** (`kind = 2`): flags bit 0 = visible, bit 1 = has shape; `x`, `y`
//! (offset 4..12); then, when a shape is present, `width`, `height`,
//! `hotspot_x`, `hotspot_y` (16 bytes) followed by `width * height * 4` bytes of
//! RGBA.
//!
//! Every header field and every pixel payload is 4-byte aligned. The decoder is
//! `src/services/remoteDesktopFrames.ts`; keep the two in step. Any layout
//! change bumps [`WIRE_VERSION`]: the webview passes the version it decodes when
//! it subscribes and the subscription is refused on a mismatch, and the
//! webview reports a message carrying a version it does not know — so a
//! frontend/backend skew fails loudly instead of painting garbage.
//!
//! Version history: 1 (#4291) had a 16-byte RGBA-only rect header; 2 (#4424)
//! added the per-rect `encoding` and `byte_len`.
//!
//! # Delivery
//!
//! [`RemoteDesktopFrameChannels`] holds the subscribed channels per session.
//! Delivery follows the same owner scoping as the JSON events did (#3388): only
//! the window that owns the session receives its frames, and an unclaimed session
//! is broadcast to every subscribed window.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use termihub_core::connection::{CursorUpdate, DirtyRect, FrameUpdate};

use crate::window::OutputEmitTarget;

/// Message kind of a framebuffer update.
pub const KIND_FRAME: u8 = 1;
/// Message kind of a cursor update.
pub const KIND_CURSOR: u8 = 2;
/// Wire format version written into every message header.
pub const WIRE_VERSION: u8 = 2;
/// Bytes of the per-message header plus a frame's fixed fields.
pub const FRAME_HEADER_LEN: usize = 16;
/// Bytes of one rect's header (geometry, encoding, payload length), before its
/// payload.
pub const RECT_HEADER_LEN: usize = 24;
/// Rect encoding: `width * height * 4` bytes of tightly packed RGBA.
pub const RECT_ENCODING_RGBA: u32 = 0;
/// Rect encoding: a baseline JPEG decoding to exactly `width x height` (#4424).
pub const RECT_ENCODING_JPEG: u32 = 1;
/// Bytes of the per-message header plus a cursor's fixed fields.
pub const CURSOR_HEADER_LEN: usize = 12;
/// Bytes of a cursor shape's geometry, before its pixel payload.
pub const SHAPE_HEADER_LEN: usize = 16;

/// Cursor flag: the remote cursor is visible.
pub const CURSOR_FLAG_VISIBLE: u8 = 0b01;
/// Cursor flag: a shape follows the fixed fields.
pub const CURSOR_FLAG_SHAPE: u8 = 0b10;

/// Most channels one session keeps at once. A window that vanished without
/// unsubscribing is normally pruned on destroy; this caps what a missed prune
/// can leak. The oldest subscription is dropped first.
pub const MAX_SUBSCRIBERS_PER_SESSION: usize = 16;

fn push_u32(buf: &mut Vec<u8>, v: u32) {
    buf.extend_from_slice(&v.to_le_bytes());
}

fn rgba_len(width: u32, height: u32) -> Option<usize> {
    (width as usize)
        .checked_mul(height as usize)
        .and_then(|n| n.checked_mul(4))
}

/// One rect's wire payload: its encoding and the bytes to send.
fn rect_payload(rect: &DirtyRect, allow_jpeg: bool) -> Option<(u32, &[u8])> {
    if rgba_len(rect.width, rect.height) != Some(rect.data.len()) {
        return None;
    }
    match &rect.jpeg {
        Some(jpeg) if allow_jpeg && !jpeg.is_empty() => Some((RECT_ENCODING_JPEG, jpeg)),
        _ => Some((RECT_ENCODING_RGBA, &rect.data)),
    }
}

/// `len` rounded up to the next multiple of 4.
fn padded(len: usize) -> usize {
    len.div_ceil(4) * 4
}

/// Encode a (sanitized) frame update into one binary message.
///
/// With `allow_jpeg`, a rect that carries its JPEG source
/// ([`DirtyRect::jpeg`]) is sent as that JPEG; otherwise (and for every other
/// rect) the decoded RGBA goes on the wire.
///
/// The frame pump only hands over frames that passed the shared
/// [`FrameGuard`](super::frame_guard::FrameGuard), so every rect is well formed.
/// A rect whose RGBA length does not match its size is still skipped here: the
/// decoder checks an RGBA payload against the geometry, and a bad rect must not
/// reach the canvas.
pub fn encode_frame(frame: &FrameUpdate, allow_jpeg: bool) -> Vec<u8> {
    let rects: Vec<(&DirtyRect, u32, &[u8])> = frame
        .rects
        .iter()
        .filter_map(|r| rect_payload(r, allow_jpeg).map(|(enc, bytes)| (r, enc, bytes)))
        .filter(|(_, _, bytes)| u32::try_from(bytes.len()).is_ok())
        .collect();
    let payload: usize = rects
        .iter()
        .map(|(_, _, bytes)| RECT_HEADER_LEN + padded(bytes.len()))
        .sum();
    let mut buf = Vec::with_capacity(FRAME_HEADER_LEN + payload);
    buf.extend_from_slice(&[KIND_FRAME, WIRE_VERSION, 0, 0]);
    push_u32(&mut buf, frame.width);
    push_u32(&mut buf, frame.height);
    // At most `MAX_FRAMEBUFFER_DIMENSION²` 1x1 rects survive sanitizing, which
    // fits a `u32`; saturate rather than wrap on anything absurd.
    push_u32(&mut buf, u32::try_from(rects.len()).unwrap_or(u32::MAX));
    for (rect, encoding, bytes) in rects {
        push_u32(&mut buf, rect.x);
        push_u32(&mut buf, rect.y);
        push_u32(&mut buf, rect.width);
        push_u32(&mut buf, rect.height);
        push_u32(&mut buf, encoding);
        // Filtered above: every payload length fits a `u32`.
        push_u32(&mut buf, bytes.len() as u32);
        buf.extend_from_slice(bytes);
        buf.resize(buf.len() + padded(bytes.len()) - bytes.len(), 0);
    }
    buf
}

/// Whether encoding `frame` with and without JPEG differs, i.e. whether a
/// JPEG-capable and an RGBA-only subscriber need separate messages.
pub fn frame_has_jpeg(frame: &FrameUpdate) -> bool {
    frame
        .rects
        .iter()
        .any(|r| r.jpeg.as_ref().is_some_and(|j| !j.is_empty()))
}

/// Encode a (sanitized) cursor update into one binary message.
///
/// A shape whose payload length does not match its size is left out (the
/// [`CursorGuard`](super::frame_guard::CursorGuard) has already stripped such
/// shapes), so the position and visibility still arrive.
pub fn encode_cursor(cursor: &CursorUpdate) -> Vec<u8> {
    let shape = cursor
        .shape
        .as_ref()
        .filter(|s| rgba_len(s.width, s.height) == Some(s.data.len()));
    let mut flags = 0;
    if cursor.visible {
        flags |= CURSOR_FLAG_VISIBLE;
    }
    if shape.is_some() {
        flags |= CURSOR_FLAG_SHAPE;
    }
    let shape_len = shape.map_or(0, |s| SHAPE_HEADER_LEN + s.data.len());
    let mut buf = Vec::with_capacity(CURSOR_HEADER_LEN + shape_len);
    buf.extend_from_slice(&[KIND_CURSOR, WIRE_VERSION, flags, 0]);
    push_u32(&mut buf, cursor.x);
    push_u32(&mut buf, cursor.y);
    if let Some(shape) = shape {
        push_u32(&mut buf, shape.width);
        push_u32(&mut buf, shape.height);
        push_u32(&mut buf, shape.hotspot_x);
        push_u32(&mut buf, shape.hotspot_y);
        buf.extend_from_slice(&shape.data);
    }
    buf
}

/// Delivers one encoded message to a subscriber. Returns `false` when the
/// subscriber is gone and should be dropped.
pub type FrameSink = Arc<dyn Fn(Vec<u8>) -> bool + Send + Sync>;

struct Subscriber {
    id: u64,
    window: String,
    /// Whether this webview decodes JPEG rects itself (#4424).
    accept_jpeg: bool,
    sink: FrameSink,
}

/// The binary frame channels subscribed per graphical session (#4291).
#[derive(Default)]
pub struct RemoteDesktopFrameChannels {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<String, Vec<Subscriber>>>,
}

impl RemoteDesktopFrameChannels {
    /// An empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Vec<Subscriber>>> {
        // A panic while holding the lock leaves the map itself consistent.
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Subscribe `window` to `session_id`'s frames and cursor updates. With
    /// `accept_jpeg`, JPEG-sourced rects reach it compressed
    /// ([`RECT_ENCODING_JPEG`]); without, always as RGBA. Returns the
    /// subscription id for [`unsubscribe`](Self::unsubscribe).
    pub fn subscribe(
        &self,
        session_id: &str,
        window: &str,
        accept_jpeg: bool,
        sink: FrameSink,
    ) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let mut sessions = self.lock();
        let subs = sessions.entry(session_id.to_string()).or_default();
        if subs.len() >= MAX_SUBSCRIBERS_PER_SESSION {
            subs.remove(0);
        }
        subs.push(Subscriber {
            id,
            window: window.to_string(),
            accept_jpeg,
            sink,
        });
        id
    }

    /// Switch one subscription between JPEG pass-through and RGBA (#4424). The
    /// webview turns JPEG off when it cannot decode a rect, then asks for a full
    /// frame, which then arrives as RGBA. Returns whether the subscription
    /// exists.
    pub fn set_accept_jpeg(&self, session_id: &str, id: u64, accept_jpeg: bool) -> bool {
        let mut sessions = self.lock();
        let Some(sub) = sessions
            .get_mut(session_id)
            .and_then(|subs| subs.iter_mut().find(|s| s.id == id))
        else {
            return false;
        };
        sub.accept_jpeg = accept_jpeg;
        true
    }

    /// Drop one subscription. Returns whether it existed.
    pub fn unsubscribe(&self, session_id: &str, id: u64) -> bool {
        let mut sessions = self.lock();
        let Some(subs) = sessions.get_mut(session_id) else {
            return false;
        };
        let before = subs.len();
        subs.retain(|s| s.id != id);
        let removed = subs.len() != before;
        if subs.is_empty() {
            sessions.remove(session_id);
        }
        removed
    }

    /// Drop every subscription held by a destroyed window.
    pub fn remove_window(&self, window: &str) {
        let mut sessions = self.lock();
        sessions.retain(|_, subs| {
            subs.retain(|s| s.window != window);
            !subs.is_empty()
        });
    }

    /// Number of live subscriptions for a session.
    pub fn subscriber_count(&self, session_id: &str) -> usize {
        self.lock().get(session_id).map_or(0, Vec::len)
    }

    /// Deliver one encoded message for `session_id` to the subscribers `target`
    /// selects: the owning window only, or every subscriber of an unclaimed
    /// session. Subscribers whose sink reports them gone are dropped.
    pub fn send(&self, session_id: &str, target: &OutputEmitTarget, bytes: Vec<u8>) {
        let mut bytes = Some(bytes);
        self.send_encoded(session_id, target, false, |_| {
            bytes.take().unwrap_or_default()
        });
    }

    /// Deliver a frame update, encoded once per variant its recipients need:
    /// JPEG pass-through for subscribers that accept it, RGBA for the rest
    /// (#4424). A frame without JPEG rects is encoded once for everyone.
    pub fn send_frame(&self, session_id: &str, target: &OutputEmitTarget, frame: &FrameUpdate) {
        self.send_encoded(session_id, target, frame_has_jpeg(frame), |jpeg| {
            encode_frame(frame, jpeg)
        });
    }

    /// Shared delivery: `encode(accept_jpeg)` runs at most once per variant
    /// (once in total unless `variants` is set) and only extra recipients of a
    /// variant pay for a copy.
    fn send_encoded(
        &self,
        session_id: &str,
        target: &OutputEmitTarget,
        variants: bool,
        mut encode: impl FnMut(bool) -> Vec<u8>,
    ) {
        let recipients: Vec<(u64, bool, FrameSink)> = {
            let sessions = self.lock();
            let Some(subs) = sessions.get(session_id) else {
                return;
            };
            subs.iter()
                .filter(|s| match target {
                    OutputEmitTarget::Window(label) => &s.window == label,
                    OutputEmitTarget::Broadcast => true,
                })
                .map(|s| (s.id, variants && s.accept_jpeg, Arc::clone(&s.sink)))
                .collect()
        };
        // The sinks run outside the lock: a webview eval must never block a
        // concurrent subscribe.
        let mut gone = Vec::new();
        for variant in [false, true] {
            let group: Vec<&(u64, bool, FrameSink)> =
                recipients.iter().filter(|r| r.1 == variant).collect();
            let Some((last, rest)) = group.split_last() else {
                continue;
            };
            let bytes = encode(variant);
            for (id, _, sink) in rest {
                if !sink(bytes.clone()) {
                    gone.push(*id);
                }
            }
            if !(last.2)(bytes) {
                gone.push(last.0);
            }
        }
        for id in gone {
            self.unsubscribe(session_id, id);
        }
    }
}

#[cfg(test)]
#[path = "remote_desktop_frames_tests.rs"]
mod tests;
