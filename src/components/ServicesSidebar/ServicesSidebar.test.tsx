/** The Services sidebar (#6028): groups, search, numbers, New, keys, held order. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";

const { connectAgent } = vi.hoisted(() => ({ connectAgent: vi.fn(() => Promise.resolve(true)) }));
vi.mock("@/utils/connectAgent", () => ({ connectAgentWithCredentials: connectAgent }));
vi.mock("@/services/embeddedServerApi", () => ({
  listNetworkInterfaces: vi.fn(() => Promise.resolve([])),
}));

import { useAppStore } from "@/store/appStore";
import { seedAgentsRegion } from "@/test/agentsRegionTestHarness";
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
  useAppStore.setState({ ...useAppStore.getInitialState(), openTunnelEditorTab });
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
    expect(q("services-counts")?.textContent).toBe("1 of 3 running· 2 error");
    await click("service-count-error");
    expect(shown()).toEqual([
      "service-group-tunnels",
      "tunnel-item-b",
      "service-group-file-servers",
      "server-item-s",
    ]);
    expect(q("service-count-error")?.getAttribute("aria-pressed")).toBe("true");
    await click("service-count-error");
    expect(items()).toHaveLength(5);
  });

  it("the search finds in both, and says when there is nothing", async () => {
    seed([[tunnel("a"), "disconnected"]], [[server("s"), "stopped"]]);
    await render();
    await search("/srv/share");
    expect(shown()).toEqual(["service-group-file-servers", "server-item-s"]);
    await search("5432");
    expect(shown()).toEqual(["service-group-tunnels", "tunnel-item-a"]);
    await search("zzz");
    expect(q("services-none")?.textContent).toContain('No service matches "zzz".');
    await click("services-search-clear");
    expect(items()).toHaveLength(4);
  });
});

describe("an offline agent", () => {
  it("is said once, and connected from there", async () => {
    seed([
      [tunnel("a", { host: EDGE }), "notReachable", AWAY],
      [tunnel("b", { host: EDGE }), "waiting", { ...AWAY, error: "Starts until 14:32." }],
    ]);
    await render();
    expect(shown()).toEqual([
      "service-group-tunnels",
      "service-agent-edge",
      "tunnel-item-a",
      "tunnel-item-b",
    ]);
    expect(q("service-agent-edge")?.textContent).toBe(
      "Edge boxOffline, 2 services. What runs there may go on; termiHub cannot tell. Connect agent"
    );
    for (const id of ["a", "b"]) {
      expect(q(`tunnel-machine-${id}`)).toBeNull();
      expect(q(`tunnel-connect-agent-${id}`)).toBeNull();
      expect(q(`tunnel-item-${id}`)?.getAttribute("aria-level")).toBe("3");
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
    expect(shown()).toEqual([
      "service-group-file-servers",
      "service-agent-edge",
      "server-item-s",
      "server-item-t",
    ]);
    expect(q("server-machine-s")).toBeNull();
    expect(q("server-reason-s")).toBeNull();
    act(() => q("service-agent-edge")!.focus());
    key(q("service-agent-edge")!, "Enter");
    await flushAsync();
    expect(connectAgent).toHaveBeenCalledOnce();
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
    expect(q("server-dialog-name")).not.toBeNull();
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
    expect(labels[0][1]).toContain("Reach something on a serverSSH tunnel, local (ssh -L)");
  });

  it.each(["local", "remote", "dynamic"])("a %s tunnel opens its editor", async (type) => {
    await render();
    await click(`services-empty-tunnel-${type}`);
    expect(openTunnelEditorTab).toHaveBeenCalledWith(null, { tunnelType: type });
  });

  it.each([
    ["http", "8080"],
    ["ftp", "2121"],
    ["tftp", "6969"],
  ])("a %s server opens its dialog", async (type, port) => {
    await render();
    await click(`services-empty-server-${type}`);
    expect(
      q(`server-dialog-proto-${type}`)?.getAttribute("aria-checked") ??
        q(`server-dialog-proto-${type}`)?.getAttribute("data-state")
    ).toMatch(/true|checked/);
    expect((q("server-dialog-port") as HTMLInputElement).value).toBe(port);
    expect(useServicesView.getState().requested).toBeNull();
  });

  it("a list without rows says what services are for", async () => {
    await render();
    expect(q("services-empty")?.textContent).toContain("No services yet.");
    expect(q("services-empty")?.textContent).toContain("needs a saved SSH connection");
    for (const id of ENTRIES) expect(q(`services-empty-${id}`), id).not.toBeNull();
    expect(q("services-search")).toBeNull();
  });

  it("a request from elsewhere is taken up when the sidebar opens, once", async () => {
    useServicesView.getState().requestFileServer("ftp");
    await render();
    expect(q("server-dialog-name")).not.toBeNull();
    await click("server-dialog-cancel");
    act(() => root.unmount());
    root = createRoot(container);
    await render();
    expect(q("server-dialog-name")).toBeNull();
  });
});
