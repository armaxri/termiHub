/**
 * Tests for the status-bar window affordance (#1902).
 *
 * When more than one native window is open, the status bar shows the current
 * window's name so windows are distinguishable at a glance. With a single window
 * open it renders nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { StatusBar } from "./StatusBar";
import type { WindowInfoState } from "@/hooks/useWindowInfo";

// Stub the unrelated status-bar children so the test isolates the window item.
vi.mock("@/components/CredentialStoreIndicator", () => ({ CredentialStoreIndicator: () => null }));
vi.mock("./PortableBadge", () => ({ PortableBadge: () => null }));
vi.mock("./UpdateIndicator", () => ({ UpdateIndicator: () => null }));

// The window registry is backend-sourced; drive it directly in the test.
let windowInfo: WindowInfoState = { label: "main", name: "Main Window", count: 1 };
vi.mock("@/hooks/useWindowInfo", () => ({
  useWindowInfo: () => windowInfo,
}));

describe("StatusBar — window affordance", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    windowInfo = { label: "main", name: "Main Window", count: 1 };
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows nothing when only one window is open", () => {
    windowInfo = { label: "main", name: "Main Window", count: 1 };
    act(() => root.render(React.createElement(StatusBar)));
    expect(container.querySelector('[data-testid="status-bar-window"]')).toBeNull();
  });

  it("shows the window name when more than one window is open", () => {
    windowInfo = { label: "win-1", name: "Window 1", count: 2 };
    act(() => root.render(React.createElement(StatusBar)));
    const item = container.querySelector('[data-testid="status-bar-window"]');
    expect(item).not.toBeNull();
    expect(item!.textContent).toContain("Window 1");
  });
});
