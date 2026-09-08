import { describe, it, expect } from "vitest";
import { isFitReady, MIN_FIT_PX } from "./safeFit";

/** A div reporting fixed layout dimensions (jsdom has no layout). */
function sizedEl(width: number, height: number): HTMLElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "offsetWidth", { configurable: true, value: width });
  Object.defineProperty(el, "offsetHeight", { configurable: true, value: height });
  return el;
}

describe("isFitReady (#2693 degenerate-container fit guard)", () => {
  it("is false for a null/undefined element", () => {
    expect(isFitReady(null)).toBe(false);
    expect(isFitReady(undefined)).toBe(false);
  });

  it("is false for a parked / mid-reparent 0-sized element", () => {
    // The exact state that produced the 2×1 destructive resize in the nightly.
    expect(isFitReady(sizedEl(0, 0))).toBe(false);
    expect(isFitReady(sizedEl(1, 1))).toBe(false);
  });

  it("is false when either axis is below the threshold", () => {
    expect(isFitReady(sizedEl(MIN_FIT_PX - 1, 300))).toBe(false);
    expect(isFitReady(sizedEl(500, MIN_FIT_PX - 1))).toBe(false);
  });

  it("is true once the element is laid out at a sane size", () => {
    expect(isFitReady(sizedEl(MIN_FIT_PX, MIN_FIT_PX))).toBe(true);
    expect(isFitReady(sizedEl(500, 300))).toBe(true);
  });
});
