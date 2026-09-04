/**
 * Tests for the shared remote-desktop status-bar segment (#1709).
 *
 * While a graphical `remote-desktop` tab is active, the status bar shows a
 * `<monitor> host:port · WxH · N-bit` segment: host:port and colour depth from
 * the connection config, and the live resolution from the framebuffer surfaced
 * to the store. It disappears for any other active tab.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { StatusBar } from "./StatusBar";
import type { ConnectionConfig, TerminalTab } from "@/types/terminal";
import { layoutState, seedLayoutState } from "@/test/layoutState";

function setActiveTab(tab: Partial<TerminalTab> & { config: ConnectionConfig }) {
  const leafId = layoutState().rootPanel.id;
  const fullTab: TerminalTab = {
    id: "tab-1",
    sessionId: "s1",
    title: "target",
    connectionType: "remote-session",
    contentType: "remote-desktop",
    panelId: leafId,
    isActive: true,
    ...tab,
  };
  seedLayoutState({
    rootPanel: { type: "leaf", id: leafId, tabs: [fullTab], activeTabId: fullTab.id },
    activePanelId: leafId,
  });
}

describe("StatusBar — remote-desktop segment", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const query = () => container.querySelector('[data-testid="status-bar-remote-desktop"]');

  it("shows host:port and colour depth for an active remote-desktop tab", () => {
    setActiveTab({
      config: { type: "vnc", config: { host: "kiosk", port: 5901, colorDepth: "32" } },
    });

    act(() => root.render(React.createElement(StatusBar)));

    const item = query();
    expect(item).not.toBeNull();
    expect(item!.textContent).toContain("kiosk:5901");
    expect(item!.textContent).toContain("32-bit");
  });

  it("includes the live framebuffer resolution once it is surfaced to the store", () => {
    setActiveTab({
      sessionId: "vnc-1",
      config: { type: "vnc", config: { host: "kiosk", port: 5901, colorDepth: "16" } },
    });
    act(() => useAppStore.getState().setRemoteDesktopResolution("vnc-1", 1920, 1080));

    act(() => root.render(React.createElement(StatusBar)));

    const item = query();
    expect(item).not.toBeNull();
    expect(item!.textContent).toContain("1920×1080");
    expect(item!.textContent).toContain("16-bit");
  });

  it("hides the resolution before the first frame arrives", () => {
    setActiveTab({
      sessionId: "vnc-2",
      config: { type: "vnc", config: { host: "kiosk", port: 5901, colorDepth: "24" } },
    });

    act(() => root.render(React.createElement(StatusBar)));

    const item = query();
    expect(item).not.toBeNull();
    expect(item!.textContent).toContain("kiosk:5901");
    expect(item!.textContent).not.toContain("×");
  });

  it("renders nothing when the active tab is not a remote-desktop tab", () => {
    setActiveTab({
      connectionType: "ssh",
      contentType: "terminal",
      config: { type: "ssh", config: { host: "app-server", username: "deploy" } },
    });

    act(() => root.render(React.createElement(StatusBar)));

    expect(query()).toBeNull();
  });
});
