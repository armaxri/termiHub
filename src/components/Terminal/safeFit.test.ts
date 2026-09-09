import { describe, it, expect } from "vitest";
import { isFitReady, isProposedFitSafe, MIN_FIT_PX, MIN_SAFE_FIT_COLS } from "./safeFit";

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

/** A stub FitAddon whose proposeDimensions returns a fixed value (or throws). */
function fitAddonProposing(dims: { cols: number; rows: number } | undefined | "throw"): {
  proposeDimensions: () => { cols: number; rows: number } | undefined;
} {
  return {
    proposeDimensions: () => {
      if (dims === "throw") throw new Error("element detached");
      return dims;
    },
  };
}

describe("isProposedFitSafe (#2700 degenerate-proposed-dimensions guard)", () => {
  it("is false for a null/undefined fit addon", () => {
    expect(isProposedFitSafe(null)).toBe(false);
    expect(isProposedFitSafe(undefined)).toBe(false);
  });

  it("is false when the container cannot be measured (undefined / throws)", () => {
    // proposeDimensions returns undefined when the terminal element is detached
    // or its cell size is 0 — mid-reparent. Never fit then.
    expect(isProposedFitSafe(fitAddonProposing(undefined))).toBe(false);
    expect(isProposedFitSafe(fitAddonProposing("throw"))).toBe(false);
  });

  it("is false at xterm's ~2-column clamp — the full-height/~0-width collapse", () => {
    // The exact residual signature from the nightly app.log: cols=2, full rows.
    expect(isProposedFitSafe(fitAddonProposing({ cols: 2, rows: 27 }))).toBe(false);
    expect(isProposedFitSafe(fitAddonProposing({ cols: 2, rows: 36 }))).toBe(false);
  });

  it("is false just below the safe column floor", () => {
    expect(isProposedFitSafe(fitAddonProposing({ cols: MIN_SAFE_FIT_COLS - 1, rows: 30 }))).toBe(
      false
    );
  });

  it("is true once the proposal is a sane, non-degenerate terminal size", () => {
    expect(isProposedFitSafe(fitAddonProposing({ cols: MIN_SAFE_FIT_COLS, rows: 1 }))).toBe(true);
    expect(isProposedFitSafe(fitAddonProposing({ cols: 40, rows: 27 }))).toBe(true);
    expect(isProposedFitSafe(fitAddonProposing({ cols: 85, rows: 36 }))).toBe(true);
  });
});
