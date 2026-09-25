//! Shared frame-bounds guard for graphical (remote-desktop) sessions (MOCK-011).
//!
//! Every graphical backend — mock, VNC, RDP sidecar — delivers its frames on a
//! [`FrameReceiver`](termihub_core::connection::FrameReceiver) that the
//! [`GraphicalSessionManager`](super::graphical_manager::GraphicalSessionManager)
//! frame pump drains. This guard sits in that single choke point, so the shared
//! bound ([`MAX_FRAMEBUFFER_DIMENSION`] and the dirty-rect checks in
//! [`FrameUpdate::sanitize`]) holds for every backend, not only for the
//! self-clamping mock.
//!
//! Per frame: an oversize / zero framebuffer is dropped whole; out-of-bounds or
//! malformed rects are dropped individually and the valid remainder is emitted.
//! A backend that keeps producing nothing but garbage is treated as broken or
//! hostile: after [`MAX_CONSECUTIVE_REJECTED_FRAMES`] such frames in a row the
//! guard asks the pump to abort, which surfaces a typed `Disconnected` state
//! carrying [`REJECTED_FRAMES_MESSAGE`]. The guard never panics and never
//! allocates from the untrusted sizes.

use termihub_core::connection::FrameUpdate;
#[cfg(doc)]
use termihub_core::connection::MAX_FRAMEBUFFER_DIMENSION;
use tracing::{debug, warn};

/// Consecutive fully-rejected frames after which the session is dropped.
///
/// Large enough that a transient burst of bad rects (e.g. a racing resize) is
/// survivable, small enough that a hostile stream is cut off within a second or
/// two of frames.
pub const MAX_CONSECUTIVE_REJECTED_FRAMES: u32 = 32;

/// Message attached to the `Disconnected` state when the guard aborts a session.
pub const REJECTED_FRAMES_MESSAGE: &str =
    "The remote desktop sent invalid framebuffer updates (oversized or malformed); disconnected.";

/// What the frame pump should do with one incoming frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameVerdict {
    /// Emit this (sanitized) frame to the frontend.
    Emit(FrameUpdate),
    /// Drop the frame; keep pumping.
    Drop,
    /// Too many consecutive invalid frames: stop pumping and drop the session.
    Abort,
}

/// Stateful per-session guard applying the shared frame bounds.
#[derive(Debug, Default)]
pub struct FrameGuard {
    consecutive_rejected: u32,
}

impl FrameGuard {
    /// A fresh guard with no rejection history.
    pub fn new() -> Self {
        Self::default()
    }

    /// Validate one untrusted frame from a backend.
    pub fn admit(&mut self, session_id: &str, frame: FrameUpdate) -> FrameVerdict {
        match frame.sanitize() {
            Err(violation) => {
                self.log_rejection(session_id, &violation.to_string());
                self.reject()
            }
            Ok(sanitized) if sanitized.is_fully_rejected() => {
                let first = sanitized.dropped.first().map(ToString::to_string);
                self.log_rejection(session_id, first.as_deref().unwrap_or("invalid rects"));
                self.reject()
            }
            Ok(sanitized) => {
                if !sanitized.dropped.is_empty() {
                    debug!(
                        session_id,
                        dropped = sanitized.dropped.len(),
                        kept = sanitized.frame.rects.len(),
                        "dropped invalid dirty rects from graphical frame"
                    );
                }
                self.consecutive_rejected = 0;
                FrameVerdict::Emit(sanitized.frame)
            }
        }
    }

    fn reject(&mut self) -> FrameVerdict {
        self.consecutive_rejected = self.consecutive_rejected.saturating_add(1);
        if self.consecutive_rejected >= MAX_CONSECUTIVE_REJECTED_FRAMES {
            FrameVerdict::Abort
        } else {
            FrameVerdict::Drop
        }
    }

    /// Warn on the first rejection of a streak; stay at debug for the rest so a
    /// hostile stream cannot flood the log.
    fn log_rejection(&self, session_id: &str, reason: &str) {
        if self.consecutive_rejected == 0 {
            warn!(session_id, reason, "dropped invalid graphical frame");
        } else {
            debug!(
                session_id,
                reason,
                streak = self.consecutive_rejected + 1,
                "dropped invalid graphical frame"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use termihub_core::connection::{DirtyRect, MAX_FRAMEBUFFER_DIMENSION};

    fn rect(x: u32, y: u32, w: u32, h: u32) -> DirtyRect {
        DirtyRect {
            x,
            y,
            width: w,
            height: h,
            data: vec![0u8; (w as usize) * (h as usize) * 4],
        }
    }

    fn frame(w: u32, h: u32, rects: Vec<DirtyRect>) -> FrameUpdate {
        FrameUpdate {
            width: w,
            height: h,
            rects,
        }
    }

    fn oversize() -> FrameUpdate {
        frame(MAX_FRAMEBUFFER_DIMENSION + 1, 1080, Vec::new())
    }

    #[test]
    fn valid_frame_is_emitted_unchanged() {
        let mut g = FrameGuard::new();
        let f = frame(1920, 1080, vec![rect(0, 0, 16, 16)]);
        assert_eq!(g.admit("s", f.clone()), FrameVerdict::Emit(f));
    }

    #[test]
    fn oversize_frame_is_dropped() {
        let mut g = FrameGuard::new();
        assert_eq!(g.admit("s", oversize()), FrameVerdict::Drop);
    }

    #[test]
    fn out_of_bounds_rects_are_stripped_and_rest_emitted() {
        let mut g = FrameGuard::new();
        let good = rect(0, 0, 4, 4);
        let f = frame(100, 100, vec![rect(99, 99, 4, 4), good.clone()]);
        assert_eq!(
            g.admit("s", f),
            FrameVerdict::Emit(frame(100, 100, vec![good]))
        );
    }

    #[test]
    fn frame_whose_only_rect_is_malformed_is_dropped() {
        let mut g = FrameGuard::new();
        let mut bad = rect(0, 0, 4, 4);
        bad.data.truncate(3);
        assert_eq!(g.admit("s", frame(100, 100, vec![bad])), FrameVerdict::Drop);
    }

    #[test]
    fn empty_resize_frame_is_not_a_rejection() {
        let mut g = FrameGuard::new();
        let f = frame(800, 600, Vec::new());
        assert_eq!(g.admit("s", f.clone()), FrameVerdict::Emit(f));
    }

    #[test]
    fn persistent_hostile_stream_aborts_at_threshold() {
        let mut g = FrameGuard::new();
        for i in 1..MAX_CONSECUTIVE_REJECTED_FRAMES {
            assert_eq!(g.admit("s", oversize()), FrameVerdict::Drop, "frame {i}");
        }
        assert_eq!(g.admit("s", oversize()), FrameVerdict::Abort);
    }

    #[test]
    fn a_valid_frame_resets_the_rejection_streak() {
        let mut g = FrameGuard::new();
        for _ in 1..MAX_CONSECUTIVE_REJECTED_FRAMES {
            assert_eq!(g.admit("s", oversize()), FrameVerdict::Drop);
        }
        let ok = frame(10, 10, Vec::new());
        assert_eq!(g.admit("s", ok.clone()), FrameVerdict::Emit(ok));
        // The streak restarted: one more bad frame is only a drop.
        assert_eq!(g.admit("s", oversize()), FrameVerdict::Drop);
    }
}
