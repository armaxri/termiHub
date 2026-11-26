/** The Activity of a service, one view for both kinds (#6028, slice 9). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";

const { getServiceEvents, writeText, getActivity } = vi.hoisted(() => ({
  getServiceEvents: vi.fn(),
  writeText: vi.fn(() => Promise.resolve()),
  getActivity: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("@/services/serviceEventsApi", () => ({ getServiceEvents }));
const { connect } = vi.hoisted(() => ({ connect: vi.fn(() => Promise.resolve()) }));
vi.mock("@/hooks/useConnectSavedConnection", () => ({
  useConnectSavedConnection: () => ({ connect }),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText }));
vi.mock("@/services/embeddedServerApi", () => ({
  listNetworkInterfaces: vi.fn(() => Promise.resolve([])),
  getEmbeddedServerActivity: getActivity,
  clearEmbeddedServerActivity: vi.fn(() => Promise.resolve()),
  checkEmbeddedServers: vi.fn(() => Promise.resolve()),
  keepEmbeddedServerRunning: vi.fn(() => Promise.resolve()),
}));

import { useAppStore } from "@/store/appStore";
import { setupAgentsRegion } from "@/test/agentsRegionTestHarness";
import { checkA11y } from "@/test/axe";
import { seedConnectionsRegion, setupConnectionsRegion } from "@/test/connectionsHarness";
import { flushAsync } from "@/test/flushAsync";
import { withTooltip } from "@/test/tooltip";
import type { EmbeddedServerConfig, ServerStatus } from "@/types/embeddedServer";
import type { ServiceCause } from "@/types/generated/ServiceCause";
import type { TunnelConfig, TunnelStatus } from "@/types/tunnel";
import { formatClockTime } from "@/utils/formatters";
import { ServiceActivityView } from "./ServiceActivity";

const DB: TunnelConfig = {
  id: "db",
  name: "Shop database",
  sshConnectionId: "ssh-1",
  tunnelType: {
    type: "local",
    config: { localHost: "127.0.0.1", localPort: 15432, remoteHost: "db", remotePort: 5432 },
  },
  autoStart: false,
  reconnectOnDisconnect: false,
};
const DOCS: EmbeddedServerConfig = {
  id: "docs",
  name: "Docs",
  serverType: "http",
  rootDirectory: "/srv",
  bindHost: "127.0.0.1",
  port: 8080,
  autoStart: false,
  readOnly: true,
};
const SERVER = {
  id: "ssh-1",
  name: "Build Box",
  folderId: null,
  config: { type: "ssh", config: { host: "build.example", username: "u" } },
};
const STATS = { bytesSent: 2048, bytesReceived: 0, activeConnections: 0, totalConnections: 3 };

let container: HTMLDivElement;
let root: Root;
const actions = {
  startTunnel: vi.fn(async (_id: string) => {}),
  stopTunnel: vi.fn(async (_id: string) => {}),
  reconnectTunnel: vi.fn(async (_id: string) => {}),
  startEmbeddedServer: vi.fn(async (_id: string) => {}),
  stopEmbeddedServer: vi.fn(async (_id: string) => {}),
  openConnectionEditorTab: vi.fn(),
};
const onEdit = vi.fn();

function tunnelIn(
  status: TunnelStatus,
  error?: string,
  activeConnections = 0,
  cause?: ServiceCause
) {
  useAppStore.setState({
    tunnels: [DB],
    tunnelStates: {
      db: { tunnelId: "db", status, error, cause, stats: { ...STATS, activeConnections } },
    },
  });
}
function serverIn(status: ServerStatus) {
  useAppStore.setState({
    embeddedServers: [DOCS],
    embeddedServerStates: { docs: { serverId: "docs", status, stats: STATS } },
  });
}
async function render(kind: "tunnel" | "fileServer", id: string) {
  await act(async () =>
    root.render(withTooltip(<ServiceActivityView kind={kind} id={id} onEdit={onEdit} />))
  );
  await flushAsync();
}
const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (id: string) => {
  await act(async () => q(id)!.click());
  await flushAsync();
};

setupAgentsRegion();
setupConnectionsRegion();

beforeEach(() => {
  vi.clearAllMocks();
  getServiceEvents.mockResolvedValue([]);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useAppStore.setState({ ...useAppStore.getInitialState(), ...actions });
  seedConnectionsRegion({ connections: [SERVER as never] });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useAppStore.setState(useAppStore.getInitialState());
});

describe("a running tunnel", () => {
  it("says its state and since when, the address and how to use it, and four counters", async () => {
    getServiceEvents.mockResolvedValue([
      { atMs: 1000, status: "connecting" },
      { atMs: 2000, status: "connected" },
    ]);
    tunnelIn("connected");
    await render("tunnel", "db");
    expect(getServiceEvents).toHaveBeenCalledWith("db");
    expect(q("service-activity-state")!.textContent).toBe("Running");
    expect(q("service-activity-since")!.textContent).toBe(`Since ${formatClockTime(2000)}`);
    expect(q("service-activity-address")!.textContent).toBe("localhost:15432");
    expect(q("service-activity-use")!.textContent).toContain("Point your program");
    expect(q("service-activity-reach")!.textContent).toBe("Who reaches it: only this computer.");
    expect(q("service-activity-counter-total")!.textContent).toBe("3");
    expect(q("service-activity-counter-sent")!.textContent).toBe("2.0 KB");
    const events = q("service-activity-events")!.querySelectorAll("li");
    expect([...events].map((li) => li.textContent)).toEqual([
      `${formatClockTime(2000)}Running`,
      `${formatClockTime(1000)}Starting`,
    ]);
    // A file server's requests only.
    expect(container.textContent).not.toContain("Requests");
    await checkA11y(container);
  });

  it("stops at once while nobody is connected, and copies the address", async () => {
    tunnelIn("connected");
    await render("tunnel", "db");
    // The first action is the one that stands out, the rest are quiet.
    expect(q("service-activity-action-stop")!.className).toContain("ui-btn--secondary");
    expect(q("service-activity-action-restart")!.className).toContain("ui-btn--ghost");
    await click("service-activity-action-stop");
    expect(actions.stopTunnel).toHaveBeenCalledWith("db");
    await click("service-activity-action-copyAddress");
    expect(writeText).toHaveBeenCalledWith("localhost:15432");
  });

  it("asks first when someone is connected", async () => {
    tunnelIn("connected", undefined, 2);
    await render("tunnel", "db");
    await click("service-activity-action-restart");
    expect(actions.reconnectTunnel).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("2 connections are open now.");
  });

  it("reads the events again when its state changes", async () => {
    tunnelIn("connecting");
    await render("tunnel", "db");
    expect(getServiceEvents).toHaveBeenCalledTimes(1);
    expect(q("service-activity-no-events")!.textContent).toContain("Nothing happened");
    await act(async () => tunnelIn("connected"));
    await flushAsync();
    expect(getServiceEvents).toHaveBeenCalledTimes(2);
  });
});

describe("a failed one", () => {
  it("says why with the same fix as its row", async () => {
    tunnelIn("error", "Build Box refused the sign-in.");
    await render("tunnel", "db");
    expect(q("service-activity-reason")!.textContent).toContain("Build Box refused the sign-in.");
    await click("service-activity-action-retry");
    expect(actions.startTunnel).toHaveBeenCalledWith("db");
    expect(q("service-activity-address")).toBeNull();
  });

  it("an edit step opens Settings", async () => {
    useAppStore.setState({ tunnels: [{ ...DB, sshConnectionId: "gone" }], tunnelStates: {} });
    useAppStore.setState({
      tunnelStates: {
        db: { tunnelId: "db", status: "missingConnection", stats: STATS },
      },
    });
    await render("tunnel", "db");
    await click("service-activity-next-chooseConnection");
    expect(onEdit).toHaveBeenCalled();
  });
});

describe("errors with a next step (#6028, slice 10)", () => {
  it("marks the part of the path that fails, and opens a terminal on a silent server", async () => {
    tunnelIn("error", "Build Box did not answer in time.", 0, "serverSilent");
    await render("tunnel", "db");
    const fails = q("tunnel-diagram-fails")!;
    expect(fails.textContent).toBe("Fails here");
    expect(fails.closest("[data-part]")!.getAttribute("data-part")).toBe("server");
    await click("service-activity-next-openTerminal");
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ id: "ssh-1" }));
  });

  it("reviews the host key by starting again", async () => {
    tunnelIn("error", "The host key of Build Box is not trusted.", 0, "hostKeyUntrusted");
    await render("tunnel", "db");
    await click("service-activity-next-reviewKey");
    expect(actions.startTunnel).toHaveBeenCalledWith("db");
  });

  it("shows no path while nothing fails", async () => {
    tunnelIn("connected");
    await render("tunnel", "db");
    expect(q("tunnel-diagram")).toBeNull();
  });

  it("a server whose folder is gone opens Settings to choose another", async () => {
    useAppStore.setState({
      embeddedServers: [DOCS],
      embeddedServerStates: {
        docs: {
          serverId: "docs",
          status: "error",
          error: "The folder /srv does not exist.",
          cause: "folderMissing",
          stats: STATS,
        },
      },
    });
    await render("fileServer", "docs");
    await click("service-activity-next-chooseFolder");
    expect(onEdit).toHaveBeenCalled();
    expect(q("tunnel-diagram")).toBeNull();
  });
});

describe("a file server", () => {
  it("has its requests under what happened, and opens in a browser", async () => {
    serverIn("running");
    await render("fileServer", "docs");
    expect(container.textContent).toContain("Requests");
    expect(q("server-activity-docs")).not.toBeNull();
    expect(q("service-activity-action-openInBrowser")).not.toBeNull();
    expect(q("service-activity-use")!.textContent).toContain("in a browser");
  });

  it("starts with a toast when that fails", async () => {
    actions.startEmbeddedServer.mockRejectedValueOnce(new Error("Port 8080 is in use"));
    serverIn("stopped");
    await render("fileServer", "docs");
    await click("service-activity-action-start");
    expect(actions.startEmbeddedServer).toHaveBeenCalledWith("docs");
  });

  it("shows nothing for one that is gone", async () => {
    await render("fileServer", "nothing");
    expect(q("service-activity")).toBeNull();
  });
});
