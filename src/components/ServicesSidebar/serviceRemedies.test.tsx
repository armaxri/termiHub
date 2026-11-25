/**
 * The buttons beside the reason of a service do what they say, in both sidebars
 * (#6063, S-005).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";

const { connectAgent, toastError, checkEmbeddedServers, keepEmbeddedServerRunning } = vi.hoisted(
  () => ({
    keepEmbeddedServerRunning: vi.fn(() => Promise.resolve()),
    checkEmbeddedServers: vi.fn(() => Promise.resolve()),
    connectAgent: vi.fn(),
    toastError: vi.fn(),
  })
);
vi.mock("@/utils/connectAgent", () => ({ connectAgentWithCredentials: connectAgent }));
vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return { ...actual, toast: { ...actual.toast, error: toastError, success: vi.fn() } };
});
vi.mock("@/services/embeddedServerApi", () => ({
  listNetworkInterfaces: vi.fn(() => Promise.resolve([])),
  checkEmbeddedServers,
  keepEmbeddedServerRunning,
}));

import { ServicesSidebar } from "./ServicesSidebar";
import { useAppStore } from "@/store/appStore";
import { seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import { withTooltip } from "@/test/tooltip";
import type { EmbeddedServerConfig, ServerState } from "@/types/embeddedServer";
import type { TunnelConfig, TunnelState } from "@/types/tunnel";

const EDGE = { kind: "agent", agentId: "edge" } as const;
const STATS = { bytesSent: 0, bytesReceived: 0, activeConnections: 0, totalConnections: 0 };
const TUNNEL: TunnelConfig = {
  id: "t",
  name: "Shop database",
  sshConnectionId: "conn",
  tunnelType: {
    type: "local",
    config: { localHost: "127.0.0.1", localPort: 5432, remoteHost: "db", remotePort: 5432 },
  },
  autoStart: false,
  reconnectOnDisconnect: false,
};
const PROXY: TunnelConfig = {
  ...TUNNEL,
  tunnelType: { type: "dynamic", config: { localHost: "127.0.0.1", localPort: 1080 } },
};
const SERVER: EmbeddedServerConfig = {
  id: "s",
  name: "Docs",
  serverType: "http",
  rootDirectory: "/srv",
  bindHost: "127.0.0.1",
  port: 8080,
  autoStart: false,
  readOnly: true,
  host: { kind: "thisComputer" },
};

let container: HTMLDivElement;
let root: Root;
const actions = {
  startTunnel: vi.fn(async (_id: string) => {}),
  saveTunnel: vi.fn(async (_tunnel: TunnelConfig) => {}),
  reconnectTunnel: vi.fn(async (_id: string) => {}),
  retryTunnelNow: vi.fn(async (_id: string) => {}),
  checkTunnelsAgain: vi.fn(async () => {}),
  keepTunnelRunning: vi.fn(async (_id: string) => {}),
  openTunnelEditorTab: vi.fn(),
  openConnectionEditorTab: vi.fn(),
  saveEmbeddedServer: vi.fn(async (_server: EmbeddedServerConfig) => {}),
  startEmbeddedServer: vi.fn(async (_id: string) => {}),
  stopEmbeddedServer: vi.fn(async (_id: string) => {}),
  setUnlockDialogOpen: vi.fn(),
};

const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const press = (testId: string) => act(async () => q(testId)!.click());

async function tunnel(over: Partial<TunnelConfig>, state: Partial<TunnelState>) {
  useAppStore.setState({
    tunnels: [{ ...TUNNEL, ...over }],
    tunnelStates: { t: { tunnelId: "t", status: "error", error: "why", stats: STATS, ...state } },
  });
  await act(async () => root.render(withTooltip(<ServicesSidebar />)));
}

async function server(over: Partial<EmbeddedServerConfig>, state: Partial<ServerState>) {
  useAppStore.setState({
    embeddedServers: [{ ...SERVER, ...over }],
    embeddedServerStates: {
      s: { serverId: "s", status: "error", error: "why", stats: STATS, ...state },
    },
  });
  await act(async () => root.render(withTooltip(<ServicesSidebar />)));
}

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useAppStore.setState({ ...useAppStore.getInitialState(), ...actions } as never);
  seedAgentsRegion({ remoteAgents: [{ id: "edge", name: "Edge box", config: {} } as never] });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useAppStore.setState(useAppStore.getInitialState());
});

describe("Use another port", () => {
  it("saves the tunnel with it, then starts it", async () => {
    await tunnel({}, { cause: "portInUse" });
    await press("tunnel-use-port-t");
    const [[saved]] = actions.saveTunnel.mock.calls;
    expect(saved).toEqual({
      ...TUNNEL,
      tunnelType: { type: "local", config: { ...TUNNEL.tunnelType.config, localPort: 5433 } },
    });
    expect(actions.startTunnel).toHaveBeenCalledWith("t");
  });

  it("does so for a proxy", async () => {
    await tunnel(PROXY, { cause: "portInUse" });
    await press("tunnel-use-port-t");
    expect(actions.saveTunnel.mock.calls[0][0].tunnelType).toEqual({
      type: "dynamic",
      config: { localHost: "127.0.0.1", localPort: 1081 },
    });
  });

  it("starts nothing when a tunnel could not be saved, and says so", async () => {
    actions.saveTunnel.mockRejectedValueOnce(new Error("disk full"));
    await tunnel({}, { cause: "portInUse" });
    await press("tunnel-use-port-t");
    expect(actions.startTunnel).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith('Failed to change the port of "Shop database"', {
      description: "disk full",
    });
  });

  it("saves the server with it, without moving it, then starts it", async () => {
    await server({}, { cause: "portInUse" });
    await press("server-use-port-s");
    const [[saved]] = actions.saveEmbeddedServer.mock.calls;
    expect(saved).toEqual({ ...SERVER, port: 8081, host: undefined });
    expect("host" in saved).toBe(false);
    expect(actions.startEmbeddedServer).toHaveBeenCalledWith("s");
  });

  it("starts nothing when a server could not be saved, and says so", async () => {
    actions.saveEmbeddedServer.mockRejectedValueOnce(new Error("disk full"));
    await server({}, { cause: "portInUse" });
    await press("server-use-port-s");
    expect(actions.startEmbeddedServer).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith("Failed to start Docs", { description: "disk full" });
  });

  it("or the editor", async () => {
    await tunnel({}, { cause: "portInUse" });
    await press("tunnel-edit-port-t");
    expect(actions.openTunnelEditorTab).toHaveBeenCalledWith("t");
    await server({}, { cause: "portInUse" });
    await press("server-edit-port-s");
    expect(q("server-dialog-port")).not.toBeNull();
  });
});

describe("Connect agent", () => {
  it.each(["tunnel", "server"] as const)("connects the agent it runs on (%s)", async (kind) => {
    connectAgent.mockResolvedValueOnce(true);
    const away = { status: "notReachable", cause: "agentOffline" } as const;
    if (kind === "tunnel") await tunnel({ host: EDGE }, away);
    else await server({ host: EDGE }, away);
    await press(`${kind}-connect-agent-${kind[0]}`);
    expect(connectAgent.mock.calls[0][0]).toMatchObject({ id: "edge", name: "Edge box" });
    expect(toastError).not.toHaveBeenCalled();
  });

  it("says why it could not", async () => {
    connectAgent.mockRejectedValueOnce(new Error("no route"));
    await tunnel({ host: EDGE }, { status: "waiting", cause: "agentOffline" });
    await press("tunnel-connect-agent-t");
    expect(toastError.mock.calls[0][0]).toBe("Failed to connect Edge box");
  });
});

describe("the others", () => {
  it("Check again asks the agents now", async () => {
    const silent = { status: "notReachable", cause: "agentSilent" } as const;
    await tunnel({ host: EDGE }, silent);
    await press("tunnel-check-again-t");
    expect(actions.checkTunnelsAgain).toHaveBeenCalledOnce();
    await server({ host: EDGE }, silent);
    await press("server-check-again-s");
    expect(checkEmbeddedServers).toHaveBeenCalledOnce();
  });

  it("Keep running takes back a stop the agent has not got (#6076)", async () => {
    const pending = { status: "stopping", cause: "agentOffline" } as const;
    await tunnel({ host: EDGE }, pending);
    await press("tunnel-keep-running-t");
    expect(actions.keepTunnelRunning).toHaveBeenCalledWith("t");
    await server({ host: EDGE }, pending);
    await press("server-keep-running-s");
    expect(keepEmbeddedServerRunning).toHaveBeenCalledWith("s");
    keepEmbeddedServerRunning.mockRejectedValueOnce(new Error("no"));
    await press("server-keep-running-s");
    expect(toastError).toHaveBeenCalledWith("Failed to keep running Docs", { description: "no" });
  });

  it("Let devices reach it opens the settings of a server no device reaches (#6076)", async () => {
    await server({ serverType: "tftp" }, { status: "running" });
    expect(document.body.textContent).toContain("Only this computer, no device can reach it.");
    await press("server-let-reach-s");
    expect(document.querySelector('[data-testid="server-dialog-name"]')).not.toBeNull();
  });

  it("Choose machine opens the editor of a service whose agent is gone", async () => {
    const gone = { kind: "agent", agentId: "gone" } as const;
    await tunnel({ host: gone }, { status: "connected" });
    await press("tunnel-choose-machine-t");
    expect(actions.openTunnelEditorTab).toHaveBeenCalledWith("t");
    await server({ host: gone }, { status: "running" });
    await press("server-choose-machine-s");
    expect(q("server-dialog-runloc")).not.toBeNull();
  });

  it("Unlock opens the unlock dialog", async () => {
    await tunnel({}, { status: "waiting", cause: "storeLocked" });
    await press("tunnel-unlock-t");
    expect(actions.setUnlockDialogOpen).toHaveBeenLastCalledWith(true);
    await server({}, { status: "waiting", cause: "storeLocked" });
    await press("server-unlock-s");
    expect(actions.setUnlockDialogOpen).toHaveBeenCalledTimes(2);
  });

  it("Edit connection opens the SSH connection", async () => {
    await tunnel({}, { cause: "connection" });
    await press("tunnel-edit-connection-t");
    expect(actions.openConnectionEditorTab).toHaveBeenCalledWith("conn");
  });

  it("Choose connection opens the tunnel's editor", async () => {
    await tunnel({}, { status: "missingConnection" });
    await press("tunnel-choose-connection-t");
    expect(actions.openTunnelEditorTab).toHaveBeenCalledWith("t");
  });

  it("Retry now retries without asking: nothing flows through it", async () => {
    await tunnel({}, { status: "reconnecting" });
    await press("tunnel-retry-now-t");
    expect(actions.retryTunnelNow).toHaveBeenCalledWith("t");
    expect(actions.reconnectTunnel).not.toHaveBeenCalled();
    expect(q("confirm-tunnel-lifecycle-dialog")).toBeNull();
  });
});
