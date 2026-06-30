/**
 * Tests for the jump-host-only connection context-menu actions.
 *
 * A jump-host connection adds "Open Jump Host Terminal" (connects a terminal to
 * the gateway) and "Show Connection Path" (opens the hop-chain dialog). Non-jump
 * connections show neither.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { ConnectionList } from "./ConnectionList";
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

describe("ConnectionList — jump-host context menu", () => {
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

  function openMenu(connection: SavedConnection) {
    useAppStore.setState({ connections: [connection] });
    act(() => root.render(React.createElement(ConnectionList)));
    const trigger = container.querySelector(`[data-testid="connection-item-${connection.id}"]`);
    expect(trigger).not.toBeNull();
    act(() => {
      trigger!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });
  }

  it("shows the jump-host actions for a jump-host connection", () => {
    openMenu(sshConnection("app-server", { proxyJump: [hop("bastion")] }));
    expect(
      document.querySelector('[data-testid="context-connection-open-jump-host"]')
    ).not.toBeNull();
    expect(document.querySelector('[data-testid="context-connection-show-path"]')).not.toBeNull();
  });

  it("hides the jump-host actions for a direct connection", () => {
    openMenu(sshConnection("plain", {}));
    expect(document.querySelector('[data-testid="context-connection-open-jump-host"]')).toBeNull();
    expect(document.querySelector('[data-testid="context-connection-show-path"]')).toBeNull();
  });

  it("opens the connection-path dialog with the full hop chain", () => {
    openMenu(sshConnection("db-server", { proxyJump: [hop("edge"), hop("bastion")] }));
    const showPath = document.querySelector(
      '[data-testid="context-connection-show-path"]'
    ) as HTMLElement | null;
    expect(showPath).not.toBeNull();
    act(() => showPath!.click());

    const dialog = document.querySelector('[data-testid="connection-path-dialog"]');
    expect(dialog).not.toBeNull();
    // You → edge → bastion → db-server
    expect(dialog!.textContent).toContain("edge");
    expect(dialog!.textContent).toContain("bastion");
    expect(dialog!.textContent).toContain("db-server");
  });
});
