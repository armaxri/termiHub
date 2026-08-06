/**
 * Experimental gating of graphical remote-desktop connections in the sidebar
 * (#1705).
 *
 * A saved connection whose type reports `capabilities.graphical` (the mock
 * backend, and the real VNC/RDP backends) must be hidden from the connection
 * tree when `experimentalFeaturesEnabled` is off, and shown when it is on.
 * Non-graphical connections are unaffected either way.
 */
import { setupSettingsRegionMirror } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { ConnectionList } from "./ConnectionList";
import { setupConnectionsRegionFromAppStore } from "@/test/connectionsRegionTestHarness";
import { TooltipProvider } from "@/components/ui";
import type {
  SavedConnection,
  RemoteAgentDefinition,
  ConnectionTypeInfo,
} from "@/types/connection";

vi.mock("@/services/api", () => ({
  listAvailableShells: vi.fn(() => Promise.resolve([])),
  createTerminal: vi.fn(() => Promise.resolve({ sessionId: "s1" })),
  removeCredential: vi.fn(),
  storeCredential: vi.fn(() => Promise.resolve()),
  resolveCredential: vi.fn(() => Promise.resolve(null)),
  isSshKeyEncrypted: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("@/utils/frontendLog", () => ({
  frontendLog: vi.fn(),
}));

vi.mock("./AgentNode", () => ({
  AgentNode: ({ agent }: { agent: RemoteAgentDefinition }) =>
    React.createElement("div", { "data-testid": `agent-node-${agent.id}` }),
}));

const SSH_TYPE: ConnectionTypeInfo = {
  typeId: "ssh",
  displayName: "SSH",
  icon: "ssh",
  schema: { groups: [] },
  capabilities: { monitoring: false, fileBrowser: false, resize: true, persistent: false },
};

const MOCK_RD_TYPE: ConnectionTypeInfo = {
  typeId: "mock-remote-desktop",
  displayName: "Mock Remote Desktop",
  icon: "monitor",
  schema: { groups: [] },
  capabilities: {
    monitoring: false,
    fileBrowser: false,
    resize: true,
    persistent: false,
    graphical: true,
  },
};

const SSH_CONN: SavedConnection = {
  id: "ssh-1",
  name: "My SSH",
  folderId: null,
  config: { type: "ssh", config: { host: "example.com" } },
};

const RD_CONN: SavedConnection = {
  id: "rd-1",
  name: "My Desktop",
  folderId: null,
  config: { type: "mock-remote-desktop", config: { host: "example.com" } },
};

let container: HTMLDivElement;
let root: Root;

function render(experimentalFeaturesEnabled: boolean) {
  const initial = useAppStore.getInitialState();
  useAppStore.setState({
    ...initial,
    connections: [SSH_CONN, RD_CONN],
    connectionTypes: [SSH_TYPE, MOCK_RD_TYPE],
    settings: { ...initial.settings, experimentalFeaturesEnabled },
  });
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <ConnectionList />
      </TooltipProvider>
    );
  });
}

function row(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="connection-item-${id}"]`);
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

setupSettingsRegionMirror();
setupConnectionsRegionFromAppStore();

describe("ConnectionList — experimental remote-desktop gating", () => {
  it("hides graphical remote-desktop connections when the flag is off", () => {
    render(false);
    expect(row("ssh-1")).not.toBeNull();
    expect(row("rd-1")).toBeNull();
  });

  it("shows graphical remote-desktop connections when the flag is on", () => {
    render(true);
    expect(row("ssh-1")).not.toBeNull();
    expect(row("rd-1")).not.toBeNull();
  });
});
