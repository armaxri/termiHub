/**
 * The connection sidebar's selected row follows the focused tab (#5642): when a
 * tab opened from a saved connection becomes active, that connection's row is
 * the one highlighted, and switching tabs moves the highlight along.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { getActivePanelId } from "@/store/layoutSelectors";
import { ConnectionList } from "./ConnectionList";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { TooltipProvider } from "@/components/ui";
import type { SavedConnection, RemoteAgentDefinition } from "@/types/connection";
import { flushAsync } from "@/test/flushAsync";

vi.mock("@/services/api", () => ({
  listAvailableShells: vi.fn(() => Promise.resolve([])),
  createTerminal: vi.fn(() => Promise.resolve({ sessionId: "s1" })),
  removeCredential: vi.fn(),
  storeCredential: vi.fn(),
  resolveCredential: vi.fn(() => Promise.resolve(null)),
  deleteConnectionFromBackend: vi.fn(() => Promise.resolve()),
  stopPersistentSession: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/utils/frontendLog", () => ({
  frontendLog: vi.fn(),
}));

vi.mock("./AgentNode", () => ({
  AgentNode: ({ agent }: { agent: RemoteAgentDefinition }) =>
    React.createElement("div", { "data-testid": `agent-node-${agent.id}` }),
}));

function makeConnection(id: string): SavedConnection {
  return {
    id,
    name: `Connection ${id}`,
    folderId: null,
    icon: undefined,
    sourceFile: undefined,
    config: { type: "local", config: {} } as SavedConnection["config"],
    terminalOptions: undefined,
  };
}

setupConnectionsRegion();
setupSettingsRegion();

const LOCAL = { type: "local", config: {} };

function openTab(title: string, connectionId?: string): string {
  let id = "";
  act(() => {
    id = useAppStore.getState().addTab(title, "local", LOCAL, connectionId ? { connectionId } : {});
  });
  return id;
}

describe("ConnectionList — selection follows the active tab", () => {
  let container: HTMLDivElement;
  let root: Root;

  const isSelected = (id: string) =>
    container
      .querySelector(`[data-testid="connection-item-${id}"]`)
      ?.classList.contains("connection-tree__item--selected") ?? false;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    seedSettings({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: false,
      fileBrowserEnabled: false,
      experimentalFeaturesEnabled: false,
    });
    seedConnectionsRegion({
      connections: [makeConnection("conn-1"), makeConnection("conn-2")],
    });
    await act(async () => {
      root.render(
        React.createElement(TooltipProvider, {
          delayDuration: 0,
          children: React.createElement(ConnectionList),
        })
      );
    });
    await flushAsync();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("highlights the row of the newly focused tab's connection", () => {
    openTab("one", "conn-1");
    expect(isSelected("conn-1")).toBe(true);
    expect(isSelected("conn-2")).toBe(false);
  });

  it("moves the highlight when switching tabs", () => {
    const first = openTab("one", "conn-1");
    openTab("two", "conn-2");
    expect(isSelected("conn-2")).toBe(true);

    act(() => useAppStore.getState().setActiveTab(first, getActivePanelId() as string));
    expect(isSelected("conn-1")).toBe(true);
    expect(isSelected("conn-2")).toBe(false);
  });

  it("keeps a sidebar click until focus moves to another tab", () => {
    openTab("one", "conn-1");
    const row2 = container.querySelector('[data-testid="connection-item-conn-2"]') as HTMLElement;
    act(() => row2.click());
    expect(isSelected("conn-2")).toBe(true);
    expect(isSelected("conn-1")).toBe(false);
  });

  it("does not change the selection for a tab without a saved connection", () => {
    openTab("one", "conn-1");
    openTab("shell");
    expect(isSelected("conn-1")).toBe(true);
  });
});
