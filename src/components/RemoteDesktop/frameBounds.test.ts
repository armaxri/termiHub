import { describe, it, expect } from "vitest";
import { MAX_CURSOR_DIMENSION } from "@/types/remoteDesktop";
import type { CursorShape } from "@/types/remoteDesktop";
import { isCursorShapeValid } from "./frameBounds";

function shape(width: number, height: number, hotspotX = 0, hotspotY = 0): CursorShape {
  return {
    width,
    height,
    hotspotX,
    hotspotY,
    data: new Array<number>(Math.max(0, width * height * 4)).fill(0),
  };
}

describe("isCursorShapeValid", () => {
  it("accepts well-formed shapes up to the shared cap", () => {
    expect(isCursorShapeValid(shape(32, 32, 31, 0))).toBe(true);
    expect(isCursorShapeValid(shape(1, 1))).toBe(true);
    expect(
      isCursorShapeValid(
        shape(MAX_CURSOR_DIMENSION, MAX_CURSOR_DIMENSION, MAX_CURSOR_DIMENSION - 1, 0)
      )
    ).toBe(true);
  });

  it("rejects zero, oversize and non-integral dimensions", () => {
    expect(isCursorShapeValid(shape(0, 4))).toBe(false);
    expect(isCursorShapeValid({ ...shape(1, 1), width: MAX_CURSOR_DIMENSION + 1 })).toBe(false);
    expect(isCursorShapeValid({ ...shape(1, 1), height: 65_535 })).toBe(false);
    expect(isCursorShapeValid({ ...shape(2, 2), width: 1.5 })).toBe(false);
  });

  it("rejects a hotspot outside the image", () => {
    expect(isCursorShapeValid(shape(16, 16, 16, 0))).toBe(false);
    expect(isCursorShapeValid(shape(16, 16, 0, 16))).toBe(false);
    expect(isCursorShapeValid(shape(16, 16, -1, 0))).toBe(false);
  });

  it("rejects a byte length other than width * height * 4", () => {
    const short = shape(4, 4);
    short.data.pop();
    expect(isCursorShapeValid(short)).toBe(false);
    const long = shape(4, 4);
    long.data.push(0);
    expect(isCursorShapeValid(long)).toBe(false);
  });
});
