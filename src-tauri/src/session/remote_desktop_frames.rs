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
//! # Wire format (version 1, all integers little-endian `u32` unless noted)
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
//! `rect_count` rects, each `x`, `y`, `width`, `height` (16 bytes) followed by
//! exactly `width * height * 4` bytes of tightly packed RGBA.
//!
//! **Cursor** (`kind = 2`): flags bit 0 = visible, bit 1 = has shape; `x`, `y`
//! (offset 4..12); then, when a shape is present, `width`, `height`,
//! `hotspot_x`, `hotspot_y` (16 bytes) followed by `width * height * 4` bytes of
//! RGBA.
//!
//! Every header field and every pixel payload is 4-byte aligned. The decoder is
//! `src/services/remoteDesktopFrames.ts`; keep the two in step.
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

use termihub_core::connection::{CursorUpdate, FrameUpdate};

use crate::window::OutputEmitTarget;

/// Message kind of a framebuffer update.
pub const KIND_FRAME: u8 = 1;
/// Message kind of a cursor update.
pub const KIND_CURSOR: u8 = 2;
/// Wire format version written into every message header.
pub const WIRE_VERSION: u8 = 1;
/// Bytes of the per-message header plus a frame's fixed fields.
pub const FRAME_HEADER_LEN: usize = 16;
/// Bytes of one rect's geometry, before its pixel payload.
pub const RECT_HEADER_LEN: usize = 16;
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

/// Encode a (sanitized) frame update into one binary message.
///
/// The frame pump only hands over frames that passed the shared
/// [`FrameGuard`](super::frame_guard::FrameGuard), so every rect is well formed.
/// A rect whose payload length does not match its size is still skipped here,
/// because the decoder derives the payload length from the geometry and a bad
/// rect would misalign every rect after it.
pub fn encode_frame(frame: &FrameUpdate) -> Vec<u8> {
    let well_formed = || {
        frame
            .rects
            .iter()
            .filter(|r| rgba_len(r.width, r.height) == Some(r.data.len()))
    };
    let payload: usize = well_formed().map(|r| RECT_HEADER_LEN + r.data.len()).sum();
    let mut buf = Vec::with_capacity(FRAME_HEADER_LEN + payload);
    buf.extend_from_slice(&[KIND_FRAME, WIRE_VERSION, 0, 0]);
    push_u32(&mut buf, frame.width);
    push_u32(&mut buf, frame.height);
    // At most `MAX_FRAMEBUFFER_DIMENSION²` 1x1 rects survive sanitizing, which
    // fits a `u32`; saturate rather than wrap on anything absurd.
    let count = u32::try_from(well_formed().count()).unwrap_or(u32::MAX);
    push_u32(&mut buf, count);
    for rect in well_formed() {
        push_u32(&mut buf, rect.x);
        push_u32(&mut buf, rect.y);
        push_u32(&mut buf, rect.width);
        push_u32(&mut buf, rect.height);
        buf.extend_from_slice(&rect.data);
    }
    buf
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

    /// Subscribe `window` to `session_id`'s frames and cursor updates. Returns
    /// the subscription id for [`unsubscribe`](Self::unsubscribe).
    pub fn subscribe(&self, session_id: &str, window: &str, sink: FrameSink) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let mut sessions = self.lock();
        let subs = sessions.entry(session_id.to_string()).or_default();
        if subs.len() >= MAX_SUBSCRIBERS_PER_SESSION {
            subs.remove(0);
        }
        subs.push(Subscriber {
            id,
            window: window.to_string(),
            sink,
        });
        id
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
        let recipients: Vec<(u64, FrameSink)> = {
            let sessions = self.lock();
            let Some(subs) = sessions.get(session_id) else {
                return;
            };
            subs.iter()
                .filter(|s| match target {
                    OutputEmitTarget::Window(label) => &s.window == label,
                    OutputEmitTarget::Broadcast => true,
                })
                .map(|s| (s.id, Arc::clone(&s.sink)))
                .collect()
        };
        let Some(((last_id, last_sink), rest)) = recipients.split_last() else {
            return;
        };
        // The sinks run outside the lock: a webview eval must never block a
        // concurrent subscribe. Only extra recipients pay for a copy.
        let mut gone = Vec::new();
        for (id, sink) in rest {
            if !sink(bytes.clone()) {
                gone.push(*id);
            }
        }
        if !last_sink(bytes) {
            gone.push(*last_id);
        }
        for id in gone {
            self.unsubscribe(session_id, id);
        }
    }
}

#[cfg(test)]
#[path = "remote_desktop_frames_tests.rs"]
mod tests;
