import { MAX_FRAMEBUFFER_DIMENSION } from "@/types/remoteDesktop";
import type { DirtyRect } from "@/types/remoteDesktop";

/**
 * Whether a framebuffer size is safe to allocate an offscreen canvas for:
 * integral, non-zero and within `MAX_FRAMEBUFFER_DIMENSION` on both axes
 * (MOCK-011; mirrors Rust `FrameUpdate::sanitize`).
 */
export function isFramebufferSizeValid(width: number, height: number): boolean {
  return [width, height].every(
    (v) => Number.isInteger(v) && v > 0 && v <= MAX_FRAMEBUFFER_DIMENSION
  );
}

/**
 * Whether a dirty rect is non-empty, lies fully inside a `fbWidth × fbHeight`
 * framebuffer and carries exactly `width * height * 4` bytes (mirrors Rust
 * `DirtyRect::check_within`).
 */
export function isDirtyRectValid(rect: DirtyRect, fbWidth: number, fbHeight: number): boolean {
  const { x, y, width, height } = rect;
  if (![x, y, width, height].every((v) => Number.isInteger(v) && v >= 0)) return false;
  if (width === 0 || height === 0) return false;
  if (x + width > fbWidth || y + height > fbHeight) return false;
  return rect.data.length === width * height * 4;
}
