//! Server-side shadow framebuffer for the VNC backend.
//!
//! RFB delivers a framebuffer as a stream of dirty rectangles, some of which are
//! **CopyRect** operations — "copy this on-screen region to there" — which carry
//! no pixel data of their own. The shared frame contract ([`FrameUpdate`] /
//! [`DirtyRect`](crate::connection::DirtyRect)) can only *blit* pixels, so a
//! CopyRect must be resolved against a local copy of the framebuffer before it
//! is emitted. This shadow holds that copy.
//!
//! Pixels are RGBA (`width * height * 4`, row-major), matching what
//! [`vnc::PixelFormat::rgba`] decodes into and what the shared canvas blits
//! directly — no channel swap needed.

/// A local RGBA copy of the remote framebuffer, kept in lockstep with what the
/// frontend canvas shows so CopyRect regions can be resolved to real pixels.
#[derive(Debug, Default)]
pub struct FrameShadow {
    width: u32,
    height: u32,
    /// RGBA, `width * height * 4` bytes, row-major.
    data: Vec<u8>,
}

impl FrameShadow {
    /// A zero-sized shadow (before the first resolution is known).
    pub fn new() -> Self {
        Self::default()
    }

    /// Current framebuffer width in pixels.
    pub fn width(&self) -> u32 {
        self.width
    }

    /// Current framebuffer height in pixels.
    pub fn height(&self) -> u32 {
        self.height
    }

    /// Resize the shadow to `width × height`, clearing it to transparent black.
    ///
    /// A resolution change repaints the whole surface on the wire, so discarding
    /// the old contents is correct and avoids stale pixels bleeding through.
    pub fn resize(&mut self, width: u32, height: u32) {
        self.width = width;
        self.height = height;
        self.data = vec![0u8; (width as usize) * (height as usize) * 4];
    }

    /// Whether a rectangle lies fully within the current framebuffer.
    fn contains(&self, x: u32, y: u32, w: u32, h: u32) -> bool {
        x.checked_add(w)
            .zip(y.checked_add(h))
            .is_some_and(|(right, bottom)| right <= self.width && bottom <= self.height)
    }

    /// Write `rgba` (tightly packed, `w * h * 4` bytes) into the shadow at
    /// `(x, y)`.
    ///
    /// Returns `false` (writing nothing) if the rect is out of bounds or `rgba`
    /// is the wrong length — a malformed update must never corrupt the shadow.
    pub fn blit(&mut self, x: u32, y: u32, w: u32, h: u32, rgba: &[u8]) -> bool {
        if w == 0 || h == 0 {
            return rgba.is_empty();
        }
        if !self.contains(x, y, w, h) || rgba.len() != (w as usize) * (h as usize) * 4 {
            return false;
        }
        let stride = self.width as usize * 4;
        let row_bytes = w as usize * 4;
        for row in 0..h as usize {
            let dst_start = (y as usize + row) * stride + x as usize * 4;
            let src_start = row * row_bytes;
            self.data[dst_start..dst_start + row_bytes]
                .copy_from_slice(&rgba[src_start..src_start + row_bytes]);
        }
        true
    }

    /// Resolve a CopyRect: copy the `w × h` region at `(src_x, src_y)` to
    /// `(dst_x, dst_y)` within the shadow.
    ///
    /// Reads the source into a temporary first, so overlapping source and
    /// destination regions copy correctly. Returns `false` if either rect is out
    /// of bounds.
    pub fn copy_rect(
        &mut self,
        dst_x: u32,
        dst_y: u32,
        src_x: u32,
        src_y: u32,
        w: u32,
        h: u32,
    ) -> bool {
        if w == 0 || h == 0 {
            return true;
        }
        if !self.contains(src_x, src_y, w, h) || !self.contains(dst_x, dst_y, w, h) {
            return false;
        }
        let Some(region) = self.extract(src_x, src_y, w, h) else {
            return false;
        };
        self.blit(dst_x, dst_y, w, h, &region)
    }

    /// Copy out the RGBA pixels of the `w × h` rect at `(x, y)`.
    ///
    /// Returns `None` if the rect is out of bounds.
    pub fn extract(&self, x: u32, y: u32, w: u32, h: u32) -> Option<Vec<u8>> {
        if !self.contains(x, y, w, h) {
            return None;
        }
        let stride = self.width as usize * 4;
        let row_bytes = w as usize * 4;
        let mut out = vec![0u8; (w as usize) * (h as usize) * 4];
        for row in 0..h as usize {
            let src_start = (y as usize + row) * stride + x as usize * 4;
            let dst_start = row * row_bytes;
            out[dst_start..dst_start + row_bytes]
                .copy_from_slice(&self.data[src_start..src_start + row_bytes]);
        }
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a 2×2 RGBA block filled with a single color for readable asserts.
    fn solid(w: u32, h: u32, rgba: [u8; 4]) -> Vec<u8> {
        rgba.iter()
            .copied()
            .cycle()
            .take((w * h * 4) as usize)
            .collect()
    }

    #[test]
    fn resize_allocates_cleared_buffer() {
        let mut s = FrameShadow::new();
        s.resize(4, 3);
        assert_eq!(s.width(), 4);
        assert_eq!(s.height(), 3);
        assert_eq!(s.extract(0, 0, 4, 3).unwrap(), vec![0u8; 4 * 3 * 4]);
    }

    #[test]
    fn blit_writes_into_position_and_round_trips() {
        let mut s = FrameShadow::new();
        s.resize(4, 4);
        let red = solid(2, 2, [255, 0, 0, 255]);
        assert!(s.blit(1, 1, 2, 2, &red));
        assert_eq!(s.extract(1, 1, 2, 2).unwrap(), red);
        // Neighboring pixel untouched.
        assert_eq!(s.extract(0, 0, 1, 1).unwrap(), vec![0, 0, 0, 0]);
    }

    #[test]
    fn blit_rejects_out_of_bounds_and_wrong_length() {
        let mut s = FrameShadow::new();
        s.resize(4, 4);
        assert!(!s.blit(3, 3, 2, 2, &solid(2, 2, [1, 2, 3, 4]))); // exceeds edge
        assert!(!s.blit(0, 0, 2, 2, &[0, 0, 0])); // wrong length
    }

    #[test]
    fn copy_rect_duplicates_region() {
        let mut s = FrameShadow::new();
        s.resize(4, 2);
        let green = solid(2, 2, [0, 255, 0, 255]);
        s.blit(0, 0, 2, 2, &green);
        assert!(s.copy_rect(2, 0, 0, 0, 2, 2));
        assert_eq!(s.extract(2, 0, 2, 2).unwrap(), green);
    }

    #[test]
    fn copy_rect_handles_overlap() {
        let mut s = FrameShadow::new();
        s.resize(4, 1);
        // Row: [A][A][.][.]
        let a = solid(2, 1, [10, 20, 30, 255]);
        s.blit(0, 0, 2, 1, &a);
        // Copy [0,0]..2 → [1,0]..2 (overlapping by one column).
        assert!(s.copy_rect(1, 0, 0, 0, 2, 1));
        assert_eq!(s.extract(1, 0, 2, 1).unwrap(), a);
    }

    #[test]
    fn copy_rect_rejects_out_of_bounds() {
        let mut s = FrameShadow::new();
        s.resize(4, 4);
        assert!(!s.copy_rect(3, 3, 0, 0, 2, 2));
        assert!(!s.copy_rect(0, 0, 3, 3, 2, 2));
    }

    #[test]
    fn extract_out_of_bounds_is_none() {
        let mut s = FrameShadow::new();
        s.resize(2, 2);
        assert!(s.extract(0, 0, 3, 3).is_none());
    }

    #[test]
    fn zero_area_blit_is_a_noop_success() {
        let mut s = FrameShadow::new();
        s.resize(2, 2);
        assert!(s.blit(0, 0, 0, 0, &[]));
    }
}
