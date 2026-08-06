/**
 * Tests for jump-host delete protection (#941).
 *
 * Deleting a connection that other connections reference as a saved jump host
 * must warn first (it would silently break their chains); deleting an
 * unreferenced connection deletes immediately as before.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
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

const ref = (connectionId: string): JumpHostConfig => ({
  connectionId,
  host: "",
  port: 22,
  username: "",
  authMethod: "key",
});

function sshConnection(id: string, settings: Record<string, unknown> = {}): SavedConnection {
  return {
    id,
    name: id,
    folderId: null,
    config: { type: "ssh", config: { host: "target", username: "deploy", ...settings } },
  };
}

const q = (testId: string) => document.querySelector(`[data-testid="${testId}"]`) as HTMLElement;

setupConnectionsRegionFromAppStore();

describe("ConnectionList — jump-host delete protection", () => {
  let container: HTMLDivElement;
  let root: Root;
  let deleteConnection: Mock<(connectionId: string) => void>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    deleteConnection = vi.fn<(connectionId: string) => void>();
    useAppStore.setState({ settings: { ...baseSettings }, deleteConnection });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderWith(connections: SavedConnection[]) {
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

  function clickDelete(id: string) {
    const trigger = q(`connection-item-${id}`);
    expect(trigger).not.toBeNull();
    act(() => trigger.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
    const del = q("context-connection-delete");
    expect(del).not.toBeNull();
    act(() => del.click());
  }

  it("warns before deleting a connection used as a jump host", () => {
    renderWith([
      sshConnection("bastion"),
      sshConnection("app-server", { proxyJump: [ref("bastion")] }),
    ]);
    clickDelete("bastion");

    const dialog = q("confirm-delete-dialog");
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain("used as a jump host");
    expect(dialog.textContent).toContain("app-server");
    // Not deleted until confirmed.
    expect(deleteConnection).not.toHaveBeenCalled();

    act(() => q("confirm-delete-confirm").click());
    expect(deleteConnection).toHaveBeenCalledWith("bastion");
  });

  it("cancelling the warning leaves the connection in place", () => {
    renderWith([
      sshConnection("bastion"),
      sshConnection("app-server", { proxyJump: [ref("bastion")] }),
    ]);
    clickDelete("bastion");
    act(() => q("confirm-delete-cancel").click());
    expect(q("confirm-delete-dialog")).toBeNull();
    expect(deleteConnection).not.toHaveBeenCalled();
  });

  it("confirms before deleting an unreferenced connection (no silent delete)", () => {
    renderWith([
      sshConnection("lonely"),
      sshConnection("app-server", { proxyJump: [ref("bastion")] }),
    ]);
    clickDelete("lonely");

    const dialog = q("confirm-delete-dialog");
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain("lonely");
    expect(dialog.textContent).not.toContain("used as a jump host");
    // Not deleted until confirmed.
    expect(deleteConnection).not.toHaveBeenCalled();

    act(() => q("confirm-delete-confirm").click());
    expect(deleteConnection).toHaveBeenCalledWith("lonely");
  });

  it("cancelling an ordinary delete leaves the connection in place", () => {
    renderWith([sshConnection("lonely")]);
    clickDelete("lonely");
    act(() => q("confirm-delete-cancel").click());
    expect(q("confirm-delete-dialog")).toBeNull();
    expect(deleteConnection).not.toHaveBeenCalled();
  });
});
