import { describe, it, expect, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import {
  computeToastAvoidInset,
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
});
