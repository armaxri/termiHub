/**
 * Sidebar rows render a connection's icon colour / emoji (#5008) and fall
 * back to the type icon when neither is set.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { flushAsync } from "@/test/flushAsync";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { ConnectionList } from "./ConnectionList";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { TooltipProvider } from "@/components/ui";
import type { SavedConnection } from "@/types/connection";

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

function conn(id: string, patch: Partial<SavedConnection> = {}): SavedConnection {
  return { id, name: id, folderId: null, config: { type: "ssh", config: { host: id } }, ...patch };
}

setupConnectionsRegion();
setupSettingsRegion();

describe("ConnectionList — per-connection icon colour and emoji (#5008)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    seedSettings({ ...baseSettings });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(connections: SavedConnection[]) {
    seedConnectionsRegion({ connections });
    await act(async () =>
      root.render(
        React.createElement(TooltipProvider, {
          delayDuration: 0,
          children: React.createElement(ConnectionList),
        })
      )
    );
    await flushAsync();
  }

  const row = (id: string) => container.querySelector(`[data-testid="connection-item-${id}"]`)!;

  it("shows the emoji, the tinted icon, and the plain type icon side by side", async () => {
    await render([
      conn("emoji", { iconEmoji: "🐳" }),
      conn("coloured", { iconColor: "green" }),
      conn("plain"),
    ]);

    expect(row("emoji").querySelector('[data-testid="connection-icon-emoji"]')?.textContent).toBe(
      "🐳"
    );
    expect(row("coloured").querySelector("svg")?.getAttribute("data-icon-color")).toBe("green");
    const plainIcon = row("plain").querySelector("svg");
    expect(plainIcon?.getAttribute("stroke")).toBe("currentColor");
    expect(row("plain").querySelector('[data-testid="connection-icon-emoji"]')).toBeNull();
  });
});
