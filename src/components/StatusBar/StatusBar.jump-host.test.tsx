/**
 * Tests for the SSH jump-host (ProxyJump) hop chain shown in the status bar.
 *
 * When the active terminal connects through a bastion, the status bar shows
 * `SSH: user@target via gateway`. Direct connections show nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { StatusBar } from "./StatusBar";
import type { ConnectionConfig, TerminalTab } from "@/types/terminal";
import { layoutState, seedLayoutState } from "@/test/layoutState";

// Stub the unrelated status-bar children so the test isolates the hop chain.
vi.mock("@/components/CredentialStoreIndicator", () => ({ CredentialStoreIndicator: () => null }));
vi.mock("./PortableBadge", () => ({ PortableBadge: () => null }));
vi.mock("./UpdateIndicator", () => ({ UpdateIndicator: () => null }));

function setActiveTab(config: ConnectionConfig) {
  const leafId = layoutState().rootPanel.id;
  const tab: TerminalTab = {
    id: "tab-1",
    sessionId: "s1",
    title: "target",
    connectionType: "ssh",
    contentType: "terminal",
    config,
    panelId: leafId,
    isActive: true,
  };
  seedLayoutState({
    rootPanel: { type: "leaf", id: leafId, tabs: [tab], activeTabId: tab.id },
    activePanelId: leafId,
  });
}

describe("StatusBar — jump-host hop chain", () => {
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

  it("shows the hop chain for an active jump-host tab", () => {
    setActiveTab({
      type: "ssh",
      config: {
        host: "app-server",
        username: "deploy",
        proxyJump: [{ host: "bastion", port: 22, username: "admin", authMethod: "key" }],
      },
    });

    act(() => root.render(React.createElement(StatusBar)));

    const item = container.querySelector('[data-testid="status-bar-jump-host"]');
    expect(item).not.toBeNull();
    expect(item!.textContent).toContain("SSH: deploy@app-server via bastion");
  });

  it("shows nothing for a direct SSH connection", () => {
    setActiveTab({ type: "ssh", config: { host: "app-server", username: "deploy" } });

    act(() => root.render(React.createElement(StatusBar)));

    expect(container.querySelector('[data-testid="status-bar-jump-host"]')).toBeNull();
  });
});
