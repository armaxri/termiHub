/**
 * Keyboard operability of the sidebar resize handle (A11Y2-003, #4329).
 *
 * The handle used to be a bare `<div onMouseDown>`: not focusable, no
 * separator semantics, and no way to change the sidebar width without a
 * pointer. These tests render a real element with the hook's `handleProps`
 * spread on it and drive it with keyboard events.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

import { useAppStore } from "@/store/appStore";
import { useSidebarResize, SIDEBAR_KEYBOARD_STEP } from "./useSidebarResize";

let container: HTMLDivElement;
let root: Root;

function Harness({ position }: { position: "left" | "right" }) {
  const { handleProps } = useSidebarResize(position);
  return <div data-testid="handle" {...handleProps} />;
}

function render(position: "left" | "right") {
  act(() => root.render(<Harness position={position} />));
  return container.querySelector('[data-testid="handle"]') as HTMLElement;
}

function press(el: HTMLElement, key: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useAppStore.getState().setSidebarWidth(260);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useSidebarResize — keyboard separator (#4329)", () => {
  it("exposes a focusable vertical separator with its current value and bounds", () => {
    const handle = render("left");
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-label")).toBe("Resize sidebar");
    expect(handle.getAttribute("tabindex")).toBe("0");
    expect(handle.getAttribute("aria-valuenow")).toBe("260");
    expect(handle.getAttribute("aria-valuemin")).toBe("170");
    expect(handle.getAttribute("aria-valuemax")).toBe("600");
    handle.focus();
    expect(document.activeElement).toBe(handle);
  });

  it("left sidebar: ArrowRight widens and ArrowLeft narrows by one step", () => {
    const handle = render("left");
    press(handle, "ArrowRight");
    expect(useAppStore.getState().sidebarWidth).toBe(260 + SIDEBAR_KEYBOARD_STEP);
    expect(handle.getAttribute("aria-valuenow")).toBe(String(260 + SIDEBAR_KEYBOARD_STEP));
    press(handle, "ArrowLeft");
    press(handle, "ArrowLeft");
    expect(useAppStore.getState().sidebarWidth).toBe(260 - SIDEBAR_KEYBOARD_STEP);
  });

  it("right sidebar: ArrowLeft widens (the handle sits on the sidebar's left edge)", () => {
    const handle = render("right");
    press(handle, "ArrowLeft");
    expect(useAppStore.getState().sidebarWidth).toBe(260 + SIDEBAR_KEYBOARD_STEP);
    press(handle, "ArrowRight");
    press(handle, "ArrowRight");
    expect(useAppStore.getState().sidebarWidth).toBe(260 - SIDEBAR_KEYBOARD_STEP);
  });

  it("Home and End jump to the minimum and maximum width", () => {
    const handle = render("left");
    press(handle, "End");
    expect(useAppStore.getState().sidebarWidth).toBe(600);
    press(handle, "Home");
    expect(useAppStore.getState().sidebarWidth).toBe(170);
  });

  it("clamps arrow steps to the bounds", () => {
    useAppStore.getState().setSidebarWidth(595);
    const handle = render("left");
    press(handle, "ArrowRight");
    expect(useAppStore.getState().sidebarWidth).toBe(600);
  });

  it("ignores unrelated keys", () => {
    const handle = render("left");
    press(handle, "a");
    expect(useAppStore.getState().sidebarWidth).toBe(260);
  });
});
