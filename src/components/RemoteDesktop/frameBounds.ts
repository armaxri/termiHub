import { MAX_CURSOR_DIMENSION, MAX_FRAMEBUFFER_DIMENSION } from "@/types/remoteDesktop";

/** The geometry + pixel buffer every frame/cursor bound check reads. */
interface PixelRect {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

/** A dirty rect as decoded from the wire (#4291) or a JSON fixture. */
type CheckedRect = PixelRect & { x: number; y: number };

/** A cursor bitmap as decoded from the wire (#4291) or a JSON fixture. */
type CheckedCursorShape = PixelRect & { hotspotX: number; hotspotY: number };

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
export function isDirtyRectValid(rect: CheckedRect, fbWidth: number, fbHeight: number): boolean {
  const { x, y, width, height } = rect;
  if (![x, y, width, height].every((v) => Number.isInteger(v) && v >= 0)) return false;
  if (width === 0 || height === 0) return false;
  if (x + width > fbWidth || y + height > fbHeight) return false;
  return rect.data.length === width * height * 4;
}

/**
 * Whether a cursor bitmap is safe to keep: integral, non-zero and within
 * `MAX_CURSOR_DIMENSION` on both axes, hotspot inside the image, and exactly
 * `width * height * 4` bytes (mirrors Rust `CursorShape::check`, #3333).
 */
export function isCursorShapeValid(shape: CheckedCursorShape): boolean {
  const { width, height, hotspotX, hotspotY } = shape;
  if (![width, height].every((v) => Number.isInteger(v) && v > 0 && v <= MAX_CURSOR_DIMENSION)) {
    return false;
  }
  if (![hotspotX, hotspotY].every((v) => Number.isInteger(v) && v >= 0)) return false;
  if (hotspotX >= width || hotspotY >= height) return false;
  return shape.data != null && shape.data.length === width * height * 4;
}
