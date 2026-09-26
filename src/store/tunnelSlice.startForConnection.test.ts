/**
 * Per-connection port forwards (PROD-023): `startConnectionTunnels` and the
 * on-connect hook that calls it.
 *
 * - The slice dispatches `tunnel.startForConnection` only when at least one
 *   non-companion tunnel is bound to the connection with `startWithConnection`
 *   (the backend picks the tunnels and skips already-active ones).
 * - A terminal tab opened from a saved connection triggers it when its session
 *   connects (`setTabSessionId`), next to the on-connect workflow trigger.
 * - A rejected intent is logged, never thrown into the connect path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { IntentAck, ProjectionCacheState } from "@/services/transport";
import type { TunnelConfig } from "@/types/tunnel";
import type { LeafPanel, TerminalTab } from "@/types/terminal";
import { onFrontendLog } from "@/utils/frontendLog";

const { clientHooks, dispatchMock, startMock, toastMock } = vi.hoisted(() => ({
  clientHooks: {
    listener: null as null | ((state: ProjectionCacheState) => void),
  },
  dispatchMock: vi.fn(),
  startMock: vi.fn(async () => {}),
  toastMock: {
    loading: vi.fn(() => "toast-id"),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
  },
}));

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  persistConnection: vi.fn(() => Promise.resolve()),
  removeConnection: vi.fn(() => Promise.resolve()),
  persistFolder: vi.fn(() => Promise.resolve()),
  removeFolder: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() =>
    Promise.resolve({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
    })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  moveConnectionToFile: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/transport", () => ({
  createTransport: () => ({ dispatch: dispatchMock, subscribe: vi.fn(), resync: vi.fn() }),
  newClientId: () => "client-test",
  newIntentId: () => "intent-test",
  ProjectionClient: class {
    onChange(listener: (state: ProjectionCacheState) => void) {
      clientHooks.listener = listener;
      return () => {
        clientHooks.listener = null;
      };
    }
    async start() {
      await startMock();
    }
    stop() {}
  },
}));

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return { ...actual, toast: toastMock };
});

import { useAppStore } from "./appStore";
import { seedLayoutState } from "@/test/layoutState";

function makeTunnel(id: string, name: string): TunnelConfig {
  return {
    id,
    name,
    sshConnectionId: "conn-1",
    tunnelType: {
      type: "local",
      config: { localHost: "127.0.0.1", localPort: 8080, remoteHost: "127.0.0.1", remotePort: 80 },
    },
    autoStart: false,
    reconnectOnDisconnect: false,
  };
}

function bound(id: string, connectionId: string, extra: Partial<TunnelConfig> = {}): TunnelConfig {
  return {
    ...makeTunnel(id, id),
    sshConnectionId: connectionId,
    startWithConnection: true,
    ...extra,
  };
}

const accepted: IntentAck = { intentId: "intent-test", status: "accepted", produced: [] };

function startForConnectionCalls(): unknown[] {
  return dispatchMock.mock.calls
    .map((call) => call[0] as { kind: string; payload: unknown })
    .filter((i) => i.kind === "tunnel.startForConnection")
    .map((i) => i.payload);
}

/** Seed a terminal tab opened from `connectionId`, not yet connected. */
function seedTab(connectionId: string | undefined, contentType: TerminalTab["contentType"]) {
  const tab: TerminalTab = {
    id: "tab-pf",
    sessionId: null,
    title: "term",
    connectionType: "ssh",
    contentType,
    config: { type: "ssh", config: {} },
    panelId: "leaf-1",
    isActive: true,
    ...(connectionId ? { connectionId } : {}),
  };
  const leaf: LeafPanel = { type: "leaf", id: "leaf-1", tabs: [tab], activeTabId: "tab-pf" };
  seedLayoutState({ rootPanel: leaf, activePanelId: "leaf-1" });
}

describe("tunnelSlice — startConnectionTunnels (PROD-023)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    clientHooks.listener = null;
    vi.clearAllMocks();
    startMock.mockResolvedValue(undefined);
    dispatchMock.mockResolvedValue(accepted);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches tunnel.startForConnection when a flagged tunnel is bound", async () => {
    useAppStore.setState({ tunnels: [bound("tun-1", "conn-1")] });
    await useAppStore.getState().startConnectionTunnels("conn-1");
    expect(startForConnectionCalls()).toEqual([{ connectionId: "conn-1" }]);
    expect(toastMock.loading).not.toHaveBeenCalled();
  });

  it("dispatches nothing when no tunnel of the connection is flagged", async () => {
    useAppStore.setState({
      tunnels: [
        // Bound but manual.
        bound("tun-manual", "conn-1", { startWithConnection: false }),
        // Legacy config without the field at all.
        { ...makeTunnel("tun-legacy", "legacy"), sshConnectionId: "conn-1" },
        // Flagged, but for another connection.
        bound("tun-other", "conn-2"),
        // Flagged companion: follows its parent, never started directly.
        bound("tun-comp", "conn-1", { companionOf: "tun-parent" }),
      ],
    });
    await useAppStore.getState().startConnectionTunnels("conn-1");
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("logs a rejected intent instead of throwing", async () => {
    useAppStore.setState({ tunnels: [bound("tun-1", "conn-1")] });
    dispatchMock.mockResolvedValueOnce({
      intentId: "intent-test",
      status: "rejected",
      produced: [],
      error: { code: "unavailable", message: "tunnel manager is not initialized" },
    });
    const logs = await captureLogs(() => useAppStore.getState().startConnectionTunnels("conn-1"));
    expect(logs.some((m) => m.includes("tunnel manager is not initialized"))).toBe(true);
  });

  it("fires when a terminal tab for the connection connects", async () => {
    useAppStore.setState({ tunnels: [bound("tun-1", "conn-1")] });
    seedTab("conn-1", "terminal");

    useAppStore.getState().setTabSessionId("tab-pf", "sess-pf-1");

    await vi.waitFor(() => expect(startForConnectionCalls()).toEqual([{ connectionId: "conn-1" }]));
  });

  it("does not fire for a tab without a saved connection id", async () => {
    useAppStore.setState({ tunnels: [bound("tun-1", "conn-1")] });
    seedTab(undefined, "terminal");

    useAppStore.getState().setTabSessionId("tab-pf", "sess-pf-2");

    await new Promise((r) => setTimeout(r, 20));
    expect(startForConnectionCalls()).toEqual([]);
  });
});

async function captureLogs(fn: () => Promise<void> | void): Promise<string[]> {
  const messages: string[] = [];
  const off = onFrontendLog((e) => messages.push(e.message));
  try {
    await fn();
  } finally {
    off();
  }
  return messages;
}
