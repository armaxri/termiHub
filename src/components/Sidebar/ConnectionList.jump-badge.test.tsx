/**
 * Tests for the SSH jump-host (ProxyJump) hop badge in the connection tree.
 *
 * A connection routed through a bastion shows an accent hop badge with a
 * full-path tooltip; multi-hop chains add a hop-count label. Non-jump and
 * non-SSH connections show no badge.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { ConnectionList } from "./ConnectionList";
import { setupConnectionsRegionFromAppStore } from "@/test/connectionsRegionTestHarness";
import { TooltipProvider } from "@/components/ui";
import type { SavedConnection, JumpHostConfig } from "@/types/connection";

vi.mock("@/services/api", () => ({
  listAvailableShells: vi.fn(() => Promise.resolve([])),
  createTerminal: vi.fn(() => Promise.resolve({ sessionId: "s1" })),
  removeCredential: vi.fn(),
  storeCredential: vi.fn(),
  isSshKeyEncrypted: vi.fn(() => Promise.resolve(false)),
  resolveCredential: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

const baseSettings = {
  version: "1",
  externalConnectionFiles: [] as [],
  powerMonitoringEnabled: false,
  fileBrowserEnabled: false,
  experimentalFeaturesEnabled: false,
};

function hop(host: string): JumpHostConfig {
  return { host, port: 22, username: "admin", authMethod: "key" };
}

function sshConnection(id: string, settings: Record<string, unknown>): SavedConnection {
  return {
    id,
    name: id,
    folderId: null,
    config: { type: "ssh", config: { host: "target", username: "deploy", ...settings } },
  };
}

setupConnectionsRegionFromAppStore();

describe("ConnectionList — jump-host hop badge", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    useAppStore.setState({ settings: { ...baseSettings } });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(connections: SavedConnection[]) {
    useAppStore.setState({ connections });
    act(() =>
      root.render(
        React.createElement(TooltipProvider, {
          delayDuration: 0,
          children: React.createElement(ConnectionList),
        })
      )
    );
  }

  it("renders a hop badge with the full-path tooltip for a single-hop connection", () => {
    render([sshConnection("app-server", { proxyJump: [hop("bastion")] })]);

    const badge = container.querySelector('[data-testid="connection-jump-badge-app-server"]');
    expect(badge).not.toBeNull();
    expect(badge!.getAttribute("title")).toBe("Via: bastion → app-server");
    // No hop-count label for a single hop.
    expect(badge!.querySelector(".connection-tree__jump-count")).toBeNull();
  });

  it("shows a hop-count label for a multi-hop connection", () => {
    render([sshConnection("db-server", { proxyJump: [hop("edge"), hop("bastion")] })]);

    const badge = container.querySelector('[data-testid="connection-jump-badge-db-server"]');
    expect(badge).not.toBeNull();
    expect(badge!.getAttribute("title")).toBe("Via: edge → bastion → db-server");
    const count = badge!.querySelector(".connection-tree__jump-count");
    expect(count?.textContent).toBe("2");
  });

  it("renders no badge for an SSH connection without a jump host", () => {
    render([sshConnection("plain", {})]);
    expect(container.querySelector('[data-testid="connection-jump-badge-plain"]')).toBeNull();
  });
});
