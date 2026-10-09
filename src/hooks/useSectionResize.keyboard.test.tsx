/**
 * Keyboard operability of the sidebar section separator (A11Y2-003, #4329).
 *
 * The handle between two sidebar sections was a bare `<div onMouseDown>`.
 * It is now a focusable horizontal separator whose value is the upper
 * section's share (in percent), adjustable with ArrowUp/ArrowDown.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useSectionResize, SECTION_KEYBOARD_STEP_PERCENT } from "./useSectionResize";

let container: HTMLDivElement;
let root: Root;
let latestFlex: number[] = [];

function Harness() {
  const { flexValues, handleProps } = useSectionResize(2);
  latestFlex = flexValues;
  return <div data-testid="handle" {...handleProps(0)} />;
}

function render() {
  act(() => root.render(<Harness />));
  return container.querySelector('[data-testid="handle"]') as HTMLElement;
}

function press(el: HTMLElement, key: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

function share(): number {
  return Math.round((latestFlex[0] / (latestFlex[0] + latestFlex[1])) * 100);
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useSectionResize — keyboard separator (#4329)", () => {
  it("exposes a focusable horizontal separator reporting the upper section's share", () => {
    const handle = render();
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("horizontal");
    expect(handle.getAttribute("tabindex")).toBe("0");
    expect(handle.getAttribute("aria-label")).toBe("Resize sidebar sections");
    expect(handle.getAttribute("aria-valuenow")).toBe("50");
    expect(handle.getAttribute("aria-valuemin")).toBe("0");
    expect(handle.getAttribute("aria-valuemax")).toBe("100");
  });

  it("ArrowDown grows the upper section and ArrowUp shrinks it", () => {
    const handle = render();
    press(handle, "ArrowDown");
    expect(share()).toBe(50 + SECTION_KEYBOARD_STEP_PERCENT);
    expect(handle.getAttribute("aria-valuenow")).toBe(String(50 + SECTION_KEYBOARD_STEP_PERCENT));
    press(handle, "ArrowUp");
    press(handle, "ArrowUp");
    expect(share()).toBe(50 - SECTION_KEYBOARD_STEP_PERCENT);
  });

  it("never collapses a section to nothing", () => {
    const handle = render();
    for (let i = 0; i < 40; i++) press(handle, "ArrowDown");
    expect(latestFlex[1]).toBeGreaterThan(0);
    expect(share()).toBeLessThan(100);
  });
});
