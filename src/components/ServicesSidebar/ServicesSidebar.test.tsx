/** The Services sidebar (#6028): groups, search, numbers, New, keys, held order. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";

const { connectAgent } = vi.hoisted(() => ({ connectAgent: vi.fn(() => Promise.resolve(true)) }));
vi.mock("@/utils/connectAgent", () => ({ connectAgentWithCredentials: connectAgent }));
const { keepEmbeddedServerRunning } = vi.hoisted(() => ({
  keepEmbeddedServerRunning: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/services/embeddedServerApi", () => ({
  listNetworkInterfaces: vi.fn(() => Promise.resolve([])),
  keepEmbeddedServerRunning,
}));

import { toast } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import { seedConnectionsRegion } from "@/test/connectionsHarness";
import { flushAsync } from "@/test/flushAsync";
import { withTooltip } from "@/test/tooltip";
import type { EmbeddedServerConfig, ServerStatus } from "@/types/embeddedServer";
import type { TunnelConfig, TunnelStatus } from "@/types/tunnel";
import { ServicesSidebar } from "./ServicesSidebar";
import { useServicesView } from "./servicesView";

const EDGE = { kind: "agent", agentId: "edge" } as const;
const STATS = { bytesSent: 0, bytesReceived: 0, activeConnections: 0, totalConnections: 0 };
const AWAY = { error: "why", cause: "agentOffline" } as const;

function tunnel(id: string, over: Partial<TunnelConfig> = {}): TunnelConfig {
  return {
    id,
    name: `Tunnel ${id}`,
    sshConnectionId: "conn",
    tunnelType: {
      type: "local",
      config: { localHost: "127.0.0.1", localPort: 5432, remoteHost: "db", remotePort: 5432 },
    },
    autoStart: false,
    reconnectOnDisconnect: false,
    ...over,
  };
}

function server(id: string, over: Partial<EmbeddedServerConfig> = {}): EmbeddedServerConfig {
  return {
    id,
    name: `Server ${id}`,
    serverType: "http",
    rootDirectory: "/srv/share",
    bindHost: "127.0.0.1",
    port: 8080,
    autoStart: false,
    readOnly: true,
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;
const openTunnelEditorTab = vi.fn();
const openConnectionEditorTab = vi.fn();
const openServerEditorTab = vi.fn();

function seed(
  tunnels: [TunnelConfig, TunnelStatus, object?][],
  servers: [EmbeddedServerConfig, ServerStatus, object?][] = []
) {
  useAppStore.setState({
    tunnels: tunnels.map(([config]) => config),
    tunnelStates: Object.fromEntries(
      tunnels.map(([{ id }, status, more]) => [id, { tunnelId: id, status, stats: STATS, ...more }])
    ),
    embeddedServers: servers.map(([config]) => config),
    embeddedServerStates: Object.fromEntries(
      servers.map(([{ id }, status, more]) => [id, { serverId: id, status, stats: STATS, ...more }])
    ),
  });
}

const render = async () => {
  await act(async () => root.render(withTooltip(<ServicesSidebar />)));
  await flushAsync();
};
const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const click = async (testId: string) => {
  await act(async () => q(testId)!.click());
  await flushAsync();
};
const items = () => Array.from(container.querySelectorAll<HTMLElement>("[role=treeitem]"));
const shown = () => items().map((item) => item.getAttribute("data-testid"));

function key(el: HTMLElement, name: string) {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  act(() => void el.dispatchEvent(event));
}

async function search(text: string) {
  const input = q("services-search") as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function openNew() {
  await act(async () =>
    q("service-new-btn")!.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 })
    )
  );
  await flushAsync();
}

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useAppStore.setState({
    ...useAppStore.getInitialState(),
    openTunnelEditorTab,
    openConnectionEditorTab,
    openServerEditorTab,
  });
  useServicesView.setState(useServicesView.getInitialState());
  seedAgentsRegion({ remoteAgents: [{ id: "edge", name: "Edge box", config: {} } as never] });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useAppStore.setState(useAppStore.getInitialState());
});

describe("both kinds in one list", () => {
  it("in two groups with their numbers", async () => {
    seed(
      [
        [tunnel("a"), "connected"],
        [tunnel("b"), "disconnected"],
      ],
      [[server("s"), "running"]]
    );
    await render();
    expect(shown()).toEqual([
      "service-group-tunnels",
      "tunnel-item-a",
      "tunnel-item-b",
      "service-group-file-servers",
      "server-item-s",
    ]);
    expect(q("service-group-tunnels")?.textContent).toBe("SSH tunnels1 of 2 running");
    expect(q("service-group-file-servers")?.textContent).toBe("File servers1 of 1 running");
    expect(q("services-counts")?.textContent).toBe("2 of 3 running");
    expect(q("services-list")?.getAttribute("role")).toBe("tree");
    expect(items().map((item) => item.getAttribute("aria-level"))).toEqual([
      "1",
      "2",
      "2",
      "1",
      "2",
    ]);
  });

  it("the numbers show only their rows, of both kinds", async () => {
    seed(
      [
        [tunnel("a"), "connected"],
        [tunnel("b"), "error"],
      ],
      [[server("s"), "error"]]
    );
    await render();
    expect(q("services-counts")?.textContent).toBe("1 of 3 running2 errors");
    await click("service-count-error");
    expect(shown()).toEqual([
      "service-group-tunnels",
      "tunnel-item-b",
      "service-group-file-servers",
      "server-item-s",
    ]);
    expect(q("service-count-error")?.getAttribute("aria-pressed")).toBe("true");
    // What is shown, and how to see all again (#6076).
    expect(q("services-shown")?.textContent).toBe("Only errors.Show all");
    expect(q("service-group-tunnels")?.textContent).toContain("1 of 2 shown");
    await click("service-count-error");
    expect(items()).toHaveLength(5);
    expect(q("services-shown")).toBeNull();
    await click("service-count-running");
    expect(items()).toHaveLength(2);
    await click("services-show-all");
    expect(items()).toHaveLength(5);
  });

  it("a group says its problems, also while it is closed (#6076)", async () => {
    const store = { error: "The store is locked.", cause: "storeLocked" } as const;
    seed(
      [
        [tunnel("a"), "connected"],
        [tunnel("b"), "waiting", store],
        [tunnel("c"), "error"],
        [tunnel("d"), "reconnecting"],
      ],
      [[server("s"), "running"]]
    );
    await render();
    const says = (group: string) =>
      q(`service-group-${group}`)?.querySelector(".services-sidebar__group-count")?.textContent;
    // The two worst; all of them in the tooltip.
    expect(says("tunnels")).toBe("1 error · 1 reconnecting");
    expect(says("file-servers")).toBe("1 of 1 running");
    await click("service-group-tunnels");
    expect(says("tunnels")).toBe("1 error · 1 reconnecting");
    await act(async () => q("service-group-tunnels")!.focus());
    await flushAsync();
    expect(document.querySelector("[role=tooltip]")?.textContent).toBe(
      "1 of 4 running · 1 error · 1 reconnecting · 1 waiting"
    );
    // A new problem changes the line, and does not open the group.
    await act(async () =>
      useAppStore.setState((s) => ({
        embeddedServerStates: { s: { ...s.embeddedServerStates["s"], status: "error" } },
      }))
    );
    expect(says("file-servers")).toBe("1 error");
    expect(q("tunnel-item-a")).toBeNull();
  });

  it.each([
    ["ssh tunnel", "tunnel"],
    ["ssh -L", "tunnel"],
    ["port forwarding", "tunnel"],
    ["SSH tunnels", "tunnel"],
    ["file server", "server"],
    ["file servers", "server"],
    ["web server", "server"],
    ["browser", "server"],
    ["error", "server"],
    ["stopped", "tunnel"],
  ])("the search for %j finds the %s (#6076)", async (text, kind) => {
    seed([[tunnel("a"), "disconnected"]], [[server("s"), "error"]]);
    await render();
    await search(text);
    expect(items().filter((item) => item.dataset.testid?.includes("-item-"))).toHaveLength(1);
    expect(q(`${kind}-item-${kind === "tunnel" ? "a" : "s"}`)).not.toBeNull();
    expect(q("services-shown")?.textContent).toBe("1 of 2 shown");
    expect(q("services-counts")).toBeNull();
  });

  it("the search goes with a number", async () => {
    seed(
      [
        [tunnel("a"), "error"],
        [tunnel("b"), "error"],
      ],
      [[server("s"), "stopped"]]
    );
    await render();
    await click("service-count-error");
    await search("tunnel b");
    expect(q("services-shown")?.textContent).toBe("Only errors.1 of 3 shownShow all");
  });

  it("the search finds in both, and says when there is nothing", async () => {
    seed([[tunnel("a"), "disconnected"]], [[server("s"), "stopped"]]);
    await render();
    await search("/srv/share");
    expect(shown()).toEqual(["service-group-file-servers", "server-item-s"]);
    await search("5432");
    expect(shown()).toEqual(["service-group-tunnels", "tunnel-item-a"]);
    await search("zzz");
    expect(q("services-none")?.textContent).toContain(
      'No service matches "zzz". Search finds names, types, machines, folders and ports.'
    );
    await click("services-search-clear");
    expect(items()).toHaveLength(4);
  });
});

describe("Stop all (#6028, slice 11)", () => {
  const stopTunnel = vi.fn(() => Promise.resolve());
  const stopEmbeddedServer = vi.fn(() => Promise.resolve());
  const open = { stats: { ...STATS, activeConnections: 2 } };
  beforeEach(() => useAppStore.setState({ stopTunnel, stopEmbeddedServer }));

  it("stops what runs, starts or waits, and asks first when something is open", async () => {
    seed(
      [
        [tunnel("a"), "connected", open],
        [tunnel("b"), "waiting"],
        [tunnel("off"), "disconnected"],
      ],
      [[server("s"), "running"]]
    );
    await render();
    await click("services-stop-all");
    expect(stopTunnel).not.toHaveBeenCalled();
    expect(q("confirm-service-lifecycle-dialog")?.textContent).toContain("Stop all services?");
    expect(q("confirm-service-lifecycle-dialog")?.textContent).toContain(
      "2 connections are open now"
    );
    await click("confirm-service-lifecycle-confirm");
    expect(stopTunnel.mock.calls).toEqual([["a"], ["b"]]);
    expect(stopEmbeddedServer).toHaveBeenCalledWith("s");
  });

  it("stops at once when nothing is open, and is off when nothing runs", async () => {
    seed([[tunnel("a"), "connected"]]);
    await render();
    await click("services-stop-all");
    expect(stopTunnel).toHaveBeenCalledWith("a");
    act(() => seed([[tunnel("a"), "disconnected"]]));
    await flushAsync();
    expect(
      q("services-stop-all")?.hasAttribute("disabled") ||
        q("services-stop-all")?.getAttribute("aria-disabled") === "true"
    ).toBe(true);
  });

  it("says when not every one could be stopped", async () => {
    const error = vi.spyOn(toast, "error");
    stopTunnel.mockRejectedValueOnce(new Error("no"));
    seed([[tunnel("a"), "connected"]]);
    await render();
    await click("services-stop-all");
    await flushAsync();
    expect(error).toHaveBeenCalledWith("Not every service could be stopped", { description: "no" });
    error.mockRestore();
  });
});

describe("an offline agent", () => {
  it("is said once, and connected from there", async () => {
    seed([
      [tunnel("a", { host: EDGE }), "notReachable", AWAY],
      [tunnel("b", { host: EDGE }), "waiting", { ...AWAY, error: "Starts until 14:32." }],
    ]);
    await render();
    expect(shown()).toEqual(["service-agent-edge", "tunnel-item-a", "tunnel-item-b"]);
    expect(q("service-agent-edge")?.textContent).toBe(
      "Edge boxOffline. 2 tunnels run there or may; termiHub cannot tell. Connect agent"
    );
    expect(q("service-agent-edge")?.getAttribute("aria-level")).toBe("1");
    for (const id of ["a", "b"]) {
      expect(q(`tunnel-machine-${id}`)).toBeNull();
      expect(q(`tunnel-connect-agent-${id}`)).toBeNull();
      expect(q(`tunnel-item-${id}`)?.getAttribute("aria-level")).toBe("2");
    }
    // What is only the row's own stays on it.
    expect(q("tunnel-reason-a")).toBeNull();
    expect(q("tunnel-reason-b")?.textContent).toBe("Starts until 14:32.");
    await click("service-agent-connect-edge");
    expect(connectAgent.mock.calls[0]).toEqual([
      expect.objectContaining({ id: "edge" }),
      expect.anything(),
    ]);
  });

  it("is said once for file servers, too, and Enter on its line connects it", async () => {
    seed(
      [],
      [
        [server("s", { host: EDGE }), "notReachable", AWAY],
        [server("t", { host: EDGE }), "notReachable", AWAY],
      ]
    );
    await render();
    expect(shown()).toEqual(["service-agent-edge", "server-item-s", "server-item-t"]);
    expect(q("service-agent-edge")?.textContent).toContain("Offline. 2 file servers run there");
    expect(q("server-machine-s")).toBeNull();
    expect(q("server-reason-s")).toBeNull();
    act(() => q("service-agent-edge")!.focus());
    key(q("service-agent-edge")!, "Enter");
    await flushAsync();
    expect(connectAgent).toHaveBeenCalledOnce();
  });

  it("has the services of both kinds under its line, without the part that runs here", async () => {
    seed(
      [
        [tunnel("a", { host: EDGE }), "notReachable", AWAY],
        [tunnel("hop", { companionOf: "a" }), "connected"],
        [tunnel("here"), "connected"],
      ],
      [[server("s", { host: EDGE }), "notReachable", AWAY]]
    );
    await render();
    expect(shown()).toEqual([
      "service-agent-edge",
      "tunnel-item-a",
      "tunnel-item-hop",
      "server-item-s",
      "service-group-tunnels",
      "tunnel-item-here",
    ]);
    expect(q("service-agent-edge")?.textContent).toContain(
      "Offline. 1 tunnel and 1 file server run there or may; termiHub cannot tell."
    );
    expect(q("service-group-tunnels")?.textContent).toContain("1 of 1 running");
    expect(q("tunnel-item-hop")?.getAttribute("aria-level")).toBe("3");
  });

  it("says once what a stop that waits for it will do, and takes them all back (V-004)", async () => {
    const pending = { ...AWAY, status: "stopping" };
    seed(
      [
        [tunnel("a", { host: EDGE }), "stopping", AWAY],
        [tunnel("b", { host: EDGE }), "stopping", AWAY],
      ],
      [[server("s", { host: EDGE }), "stopping", pending]]
    );
    const keepTunnelRunning = vi.fn(() => Promise.resolve());
    useAppStore.setState({ keepTunnelRunning });
    await render();
    expect(q("service-agent-edge")?.textContent).toContain(
      "Offline. 2 tunnels and 1 file server will be stopped when it is back. Connect agent · Keep all running"
    );
    expect(q("tunnel-reason-a")?.textContent).toBe("Keep running");
    await click("service-agent-keep-edge");
    expect(keepTunnelRunning.mock.calls).toEqual([["a"], ["b"]]);
    expect(keepEmbeddedServerRunning).toHaveBeenCalledWith("s");
  });

  it("does not offer to keep all running while one is not stopping", async () => {
    seed([
      [tunnel("a", { host: EDGE }), "stopping", AWAY],
      [tunnel("b", { host: EDGE }), "notReachable", AWAY],
    ]);
    await render();
    expect(q("service-agent-keep-edge")).toBeNull();
    expect(q("service-agent-edge")?.textContent).toContain("run there or may");
  });

  it("with one service here is said on its row", async () => {
    seed([[tunnel("a", { host: EDGE }), "notReachable", AWAY]]);
    await render();
    expect(shown()).toEqual(["service-group-tunnels", "tunnel-item-a"]);
    expect(q("tunnel-machine-a")?.textContent).toBe("Edge box");
    expect(q("tunnel-connect-agent-a")).not.toBeNull();
  });
});

describe("the keys", () => {
  beforeEach(async () => {
    seed([[tunnel("a"), "disconnected"]], [[server("s"), "stopped"]]);
    await render();
  });

  it("has one tab stop and moves over groups and rows", () => {
    expect(items().map((item) => item.tabIndex)).toEqual([0, -1, -1, -1]);
    key(items()[0], "ArrowDown");
    expect(document.activeElement).toBe(q("tunnel-item-a"));
    key(q("tunnel-item-a")!, "ArrowDown");
    expect(document.activeElement).toBe(q("service-group-file-servers"));
    key(q("service-group-file-servers")!, "End");
    expect(document.activeElement).toBe(q("server-item-s"));
  });

  it("Enter edits a row, of either kind", async () => {
    act(() => q("tunnel-item-a")!.focus());
    key(q("tunnel-item-a")!, "Enter");
    expect(openTunnelEditorTab).toHaveBeenCalledWith("a");
    act(() => q("server-item-s")!.focus());
    key(q("server-item-s")!, "Enter");
    await flushAsync();
    expect(openServerEditorTab).toHaveBeenCalledWith("s");
  });

  it("closes and opens a group", () => {
    const group = q("service-group-tunnels")!;
    const open = () => q("service-group-tunnels")!.getAttribute("aria-expanded");
    act(() => group.focus());
    key(group, "ArrowRight");
    expect(open()).toBe("true");
    key(group, "ArrowLeft");
    expect(open()).toBe("false");
    expect(q("tunnel-item-a")).toBeNull();
    key(group, "ArrowLeft");
    expect(open()).toBe("false");
    key(group, "ArrowRight");
    expect(open()).toBe("true");
    key(group, " ");
    expect(open()).toBe("false");
    key(group, "Enter");
    expect(open()).toBe("true");
    act(() => group.click());
    expect(open()).toBe("false");
  });
});

describe("the order while somebody is in the list", () => {
  it("stays, and is sorted again when they leave", async () => {
    const list = () => shown().slice(1);
    const at = (status: TunnelStatus) =>
      act(async () =>
        seed([
          [tunnel("a"), "connected"],
          [tunnel("b"), status],
        ])
      );
    await at("connected");
    await render();
    const tree = q("services-list")!;
    const pointer = (type: string) =>
      act(() => void tree.dispatchEvent(new MouseEvent(type, { bubbles: true })));
    pointer("pointerover");
    await at("error");
    expect(list()).toEqual(["tunnel-item-a", "tunnel-item-b"]);
    pointer("pointerout");
    expect(list()).toEqual(["tunnel-item-b", "tunnel-item-a"]);

    // The same for the focus.
    act(() => q("tunnel-item-b")!.focus());
    await at("connected");
    expect(list()).toEqual(["tunnel-item-b", "tunnel-item-a"]);
    act(() => q("tunnel-item-b")!.blur());
    expect(list()).toEqual(["tunnel-item-a", "tunnel-item-b"]);
  });
});

describe("making one", () => {
  const ENTRIES = [
    "tunnel-local",
    "tunnel-remote",
    "tunnel-dynamic",
    "server-http",
    "server-ftp",
    "server-tftp",
  ];

  it("the New menu asks what it is for", async () => {
    seed([[tunnel("a"), "disconnected"]]);
    await render();
    await openNew();
    const menu = document.querySelector("[role=menu]")!;
    expect(menu.textContent).toContain("Connect through SSH");
    expect(menu.textContent).toContain("Share a folder");
    const labels = Array.from(menu.querySelectorAll("[role=menuitem]")).map((item) => [
      item.getAttribute("data-testid"),
      item.textContent,
    ]);
    expect(labels.map(([id]) => id)).toEqual(ENTRIES.map((id) => `service-new-${id}`));
    expect(labels[0][1]).toContain(
      "Reach something through a serverSuch as a database. SSH tunnel, local (ssh -L)"
    );
  });

  it.each(["local", "remote", "dynamic"])("a %s tunnel opens its editor", async (type) => {
    await render();
    await click(`services-empty-tunnel-${type}`);
    expect(openTunnelEditorTab).toHaveBeenCalledWith(null, { tunnelType: type });
  });

  it.each(["http", "ftp", "tftp"])("a %s server opens its editor", async (type) => {
    await render();
    await click(`services-empty-server-${type}`);
    expect(openServerEditorTab).toHaveBeenCalledWith(null, { serverType: type });
  });

  it("a list without rows says what services are for", async () => {
    await render();
    expect(q("services-empty")?.textContent).toContain("No services yet.");
    expect(q("services-empty")?.textContent).toContain("needs a saved SSH connection");
    for (const id of ENTRIES) expect(q(`services-empty-${id}`), id).not.toBeNull();
    expect(q("services-search")).toBeNull();
    await click("services-empty-connection");
    expect(openConnectionEditorTab).toHaveBeenCalledWith("new");
  });

  it("does not ask for an SSH connection when there is one (#6076)", async () => {
    const saved = (type: string) => ({ id: type, name: type, config: { type, config: {} } });
    seedConnectionsRegion({ folders: [], connections: [saved("local")] as never });
    await render();
    expect(q("services-empty-connection")).not.toBeNull();
    act(() => seedConnectionsRegion({ folders: [], connections: [saved("ssh")] as never }));
    await flushAsync();
    expect(q("services-empty-connection")).toBeNull();
    expect(q("services-empty")?.textContent).not.toContain("needs a saved SSH connection");
  });
});
