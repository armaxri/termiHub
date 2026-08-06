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
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { TooltipProvider } from "@/components/ui";
import type { SavedConnection, JumpHostConfig } from "@/types/connection";
import { resolveCredential } from "@/services/api";

vi.mock("@/services/api", () => ({
  listAvailableShells: vi.fn(() => Promise.resolve([])),
  createTerminal: vi.fn(() => Promise.resolve({ sessionId: "s1" })),
  removeCredential: vi.fn(),
  storeCredential: vi.fn(),
  isSshKeyEncrypted: vi.fn(() => Promise.resolve(false)),
  resolveCredential: vi.fn(() => Promise.resolve(null)),
  // The Connection Path dialog (opened by this menu) probes the path on open.
  probeConnectionPath: vi.fn(() => Promise.resolve()),
  cancelConnectionPathProbe: vi.fn(() => Promise.resolve(true)),
}));

// The Connection Path dialog subscribes to probe events while open.
vi.mock("@/services/events", () => ({
  onJumpHostHopStatus: vi.fn(() => Promise.resolve(() => {})),
  onJumpHostProbeComplete: vi.fn(() => Promise.resolve(() => {})),
}));

const mockedResolveCredential = vi.mocked(resolveCredential);
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

setupConnectionsRegion();
setupSettingsRegion();

describe("ConnectionList — jump-host context menu", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    useAppStore.setState(useAppStore.getInitialState());
    useAppStore.setState({
      credentialStoreStatus: { mode: "master_password", status: "unlocked" },
    });
    seedSettings({ ...baseSettings });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function openMenu(connection: SavedConnection) {
    seedConnectionsRegion({ connections: [connection] });
    act(() =>
      root.render(
        React.createElement(TooltipProvider, {
          delayDuration: 0,
          children: React.createElement(ConnectionList),
        })
      )
    );
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

  it("opens a jump-host terminal without prompting when the hop has an inline password (#963)", async () => {
    // A password-auth bastion with an inline password must not re-prompt: the
    // synthesized gateway carries the hop's password, so the credential is
    // already known (the synthetic id would miss the store).
    const passwordHop: JumpHostConfig = {
      host: "bastion",
      port: 22,
      username: "admin",
      authMethod: "password",
      password: "bastion-secret",
    };
    openMenu(sshConnection("app-server", { proxyJump: [passwordHop] }));

    const openGateway = document.querySelector(
      '[data-testid="context-connection-open-jump-host"]'
    ) as HTMLElement | null;
    expect(openGateway).not.toBeNull();

    await act(async () => {
      openGateway!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useAppStore.getState().passwordPromptOpen).toBe(false);
    expect(mockedResolveCredential).not.toHaveBeenCalled();
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
