/**
 * The connection editor's tunnel Remove, end to end against the real store
 * (#5216): Remove → confirm → `tunnel.remove`, then the toast's Undo re-creates
 * the tunnel under the same id. Only the projection transport and the toast
 * primitive are mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { IntentAck } from "@/services/transport";

const { dispatchMock } = vi.hoisted(() => ({ dispatchMock: vi.fn() }));

// Mock the service modules the store imports at module load. We only care about
// the projection transport + the toast primitive here, but the store pulls in
// the full graph.
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
    onChange() {
      return () => {};
    }
    async start() {}
    stop() {}
  },
}));

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: {
      loading: vi.fn(() => "toast-id"),
      success: vi.fn(),
      error: vi.fn(),
    },
  };
});

import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { toast } from "@/components/ui";
import type { TunnelConfig } from "@/types/tunnel";
import { ConnectionPortForwardingSection } from "./ConnectionPortForwardingSection";

const ACCEPTED: IntentAck = { intentId: "intent-test", status: "accepted", produced: [] };

const TUNNEL: TunnelConfig = {
  id: "tun-1",
  name: "Postgres",
  sshConnectionId: "conn-1",
  tunnelType: {
    type: "local",
    config: { localHost: "127.0.0.1", localPort: 5432, remoteHost: "db", remotePort: 5432 },
  },
  autoStart: false,
  reconnectOnDisconnect: false,
};

let container: HTMLDivElement;
let root: Root;

function byTestId(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

async function click(id: string) {
  const el = byTestId(id);
  expect(el).not.toBeNull();
  await act(async () => {
    el!.click();
  });
}

describe("ConnectionPortForwardingSection — delete with Undo (#5216)", () => {
  beforeEach(async () => {
    useAppStore.setState(useAppStore.getInitialState());
    useAppStore.setState({ tunnels: [TUNNEL] });
    vi.clearAllMocks();
    dispatchMock.mockResolvedValue(ACCEPTED);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<ConnectionPortForwardingSection connectionId="conn-1" />);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("confirm deletes the tunnel and Undo re-creates it under the same id", async () => {
    await click("port-forward-remove-tun-1");
    expect(byTestId("confirm-delete-dialog")).not.toBeNull();
    expect(dispatchMock).not.toHaveBeenCalled();

    await click("confirm-delete-confirm");
    await vi.waitFor(() =>
      expect(dispatchMock).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "tunnel.remove", payload: { id: "tun-1" } })
      )
    );

    await vi.waitFor(() => expect(toast.success).toHaveBeenCalled());
    const opts = vi.mocked(toast.success).mock.calls[0][1] as {
      action?: { label: string; onClick: () => void };
    };
    expect(opts.action?.label).toBe("Undo");
    dispatchMock.mockClear();

    opts.action!.onClick();
    await vi.waitFor(() =>
      expect(dispatchMock).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "tunnel.create", payload: TUNNEL })
      )
    );
  });

  it("cancel dispatches nothing", async () => {
    await click("port-forward-remove-tun-1");
    await click("confirm-delete-cancel");
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(byTestId("port-forward-row-tun-1")).not.toBeNull();
  });
});
