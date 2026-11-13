import { describe, it, expect, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import {
  computeToastAvoidInset,
  computeToastLayout,
  MIN_TOAST_WIDTH,
  TOAST_NARROW_CLASS,
  TOAST_WIDTH_VAR,
  TOAST_AVOID_ATTR,
  TOAST_AVOID_INSET_VAR,
  useToastAvoidInset,
  type Box,
  type ToastZone,
} from "./toastAvoid";

/** A 1280x800 window with the 340px toast column 16px from the right edge. */
const ZONE: ToastZone = {
  viewportWidth: 1280,
  viewportHeight: 800,
  width: 340,
  height: 80,
  edge: 16,
  baseInset: 0,
};

function box(left: number, top: number, right: number, bottom: number): Box {
  return { left, top, right, bottom };
}

describe("computeToastAvoidInset (#5618)", () => {
  it("keeps the base inset when nothing is in the way", () => {
    expect(computeToastAvoidInset([], ZONE)).toBe(0);
    expect(computeToastAvoidInset([], { ...ZONE, baseInset: 60 })).toBe(60);
  });

  it("lifts the stack above an editor footer in the toast column", () => {
    // A full-width footer bar 56px tall at the bottom of the window.
    const footer = box(300, 744, 1280, 800);
    expect(computeToastAvoidInset([footer], ZONE)).toBe(56);
  });

  it("ignores an element outside the toast column (a centred modal footer)", () => {
    const modalFooter = box(430, 700, 850, 760);
    expect(computeToastAvoidInset([modalFooter], ZONE)).toBe(0);
  });

  it("ignores an element above the band the stack occupies", () => {
    // Stack band: bottom 784, top 704. A footer ending at 600 is clear of it.
    const highFooter = box(800, 540, 1270, 600);
    expect(computeToastAvoidInset([highFooter], ZONE)).toBe(0);
  });

  it("clears a modal footer that reaches into the stack's corner", () => {
    const wideModalFooter = box(200, 720, 1100, 770);
    expect(computeToastAvoidInset([wideModalFooter], ZONE)).toBe(80);
  });

  it("stacks above the Transfers panel that sits above the bottom banner", () => {
    // Banner below (base inset 40), Transfers panel 160px tall above it.
    const transfers = box(0, 600, 1280, 760);
    expect(computeToastAvoidInset([transfers], { ...ZONE, baseInset: 40 })).toBe(200);
  });

  it("keeps lifting when clearing one element lands the stack on another", () => {
    const footer = box(300, 744, 1280, 800);
    const panelAbove = box(300, 600, 1280, 740);
    expect(computeToastAvoidInset([footer, panelAbove], ZONE)).toBe(200);
  });

  it("ignores empty boxes (hidden elements)", () => {
    expect(computeToastAvoidInset([box(0, 0, 0, 0), box(900, 780, 1200, 780)], ZONE)).toBe(0);
  });
});

describe("computeToastLayout — open dialogs (#5686)", () => {
  it("lifts the stack above a short dialog that reaches into its corner", () => {
    // A 640px-wide dialog on a narrower window, reaching down to y=760.
    const dialog = box(180, 300, 820, 760);
    const zone = { ...ZONE, viewportWidth: 1000 };
    expect(computeToastLayout([dialog], zone)).toEqual({ inset: 500, width: 340 });
  });

  it("narrows the column beside a dialog too tall to clear", () => {
    // The workflow editor: 640px wide, nearly the full window height.
    const dialog = box(320, 40, 960, 760);
    const footer = box(320, 700, 960, 760);
    const layout = computeToastLayout([dialog, footer], ZONE);
    // 1280 - 16 (edge) - 960 (dialog right) - 16 (gap) = 288.
    expect(layout).toEqual({ inset: 0, width: 288 });
  });

  it("keeps clear of the footer when there is no room beside a tall dialog", () => {
    const dialog = box(100, 40, 1180, 760);
    const footer = box(100, 700, 1180, 760);
    const layout = computeToastLayout([dialog, footer], ZONE);
    expect(layout.width).toBe(340);
    expect(layout.inset).toBe(100);
    expect(1280 - 16 - 1180 - 16).toBeLessThan(MIN_TOAST_WIDTH);
  });

  it("leaves the layout alone for a dialog outside the toast column", () => {
    const centredDialog = box(430, 40, 850, 760);
    expect(computeToastLayout([centredDialog], ZONE)).toEqual({ inset: 0, width: 340 });
  });

  it("matches computeToastAvoidInset for footers and panels", () => {
    const footer = box(300, 744, 1280, 800);
    const panelAbove = box(300, 600, 1280, 740);
    expect(computeToastLayout([footer, panelAbove], ZONE)).toEqual({ inset: 200, width: 340 });
  });
});

function Probe() {
  useToastAvoidInset(340, 16);
  return null;
}

describe("useToastAvoidInset (#5618)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("publishes the inset for a marked footer and removes it on unmount", () => {
    Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    const footer = document.createElement("div");
    footer.setAttribute(TOAST_AVOID_ATTR, "");
    footer.getBoundingClientRect = () =>
      ({ left: 300, top: 744, right: 1280, bottom: 800, width: 980, height: 56 }) as DOMRect;
    document.body.appendChild(footer);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(React.createElement(Probe)));
    const html = document.documentElement;
    expect(html.style.getPropertyValue(TOAST_AVOID_INSET_VAR)).toBe("56px");
    act(() => root.unmount());
    expect(html.style.getPropertyValue(TOAST_AVOID_INSET_VAR)).toBe("");
  });

  it("narrows the column beside a tall marked dialog and restores it on unmount", () => {
    Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    const dialog = document.createElement("div");
    dialog.setAttribute(TOAST_AVOID_ATTR, "");
    dialog.getBoundingClientRect = () =>
      ({ left: 320, top: 40, right: 960, bottom: 760, width: 640, height: 720 }) as DOMRect;
    document.body.appendChild(dialog);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(React.createElement(Probe)));
    const html = document.documentElement;
    expect(html.style.getPropertyValue(TOAST_WIDTH_VAR)).toBe("288px");
    expect(html.classList.contains(TOAST_NARROW_CLASS)).toBe(true);
    act(() => root.unmount());
    expect(html.style.getPropertyValue(TOAST_WIDTH_VAR)).toBe("");
    expect(html.classList.contains(TOAST_NARROW_CLASS)).toBe(false);
  });
});
