import { describe, expect, it } from "vitest";
import type { SavedConnection } from "@/types/connection";
import type { EmbeddedServerConfig, ServerState, ServerStatus } from "@/types/embeddedServer";
import type { TunnelConfig, TunnelState, TunnelStatus, TunnelType } from "@/types/tunnel";
import {
  fileServerModel,
  SERVICE_ACTION_ORDER,
  tunnelModel,
  type ServiceActionId,
  type ServiceContext,
  type ServiceModel,
} from "./serviceModel";

const CONTEXT: ServiceContext = {
  agents: [
    { id: "edge", name: "Edge box", config: { host: "edge.example" } as never },
    { id: "nohost", name: "Lab", config: {} as never },
  ],
  connections: [
    {
      id: "shop",
      name: "shop-web",
      config: { type: "ssh", config: { host: "shop.example" } },
    } as unknown as SavedConnection,
  ],
  networkAddress: "192.168.1.20",
};
const EDGE = { kind: "agent", agentId: "edge" } as const;
const STATS = { bytesSent: 1, bytesReceived: 2, activeConnections: 3, totalConnections: 4 };

const LOCAL: TunnelType = {
  type: "local",
  config: { localHost: "127.0.0.1", localPort: 5432, remoteHost: "db", remotePort: 5432 },
};
const remote = (remoteHost: string): TunnelType => ({
  type: "remote",
  config: { remoteHost, remotePort: 9000, localHost: "localhost", localPort: 3000 },
});
const DYNAMIC: TunnelType = {
  type: "dynamic",
  config: { localHost: "127.0.0.1", localPort: 1080 },
};

function tunnel(over: Partial<TunnelConfig> = {}): TunnelConfig {
  return {
    id: "t",
    name: "Shop database",
    sshConnectionId: "shop",
    tunnelType: LOCAL,
    autoStart: false,
    reconnectOnDisconnect: false,
    ...over,
  };
}

function tunnelIn(status: TunnelStatus, over: Partial<TunnelState> = {}): TunnelState {
  return { tunnelId: "t", status, error: "why", stats: STATS, ...over };
}

function server(over: Partial<EmbeddedServerConfig> = {}): EmbeddedServerConfig {
  return {
    id: "s",
    name: "Docs",
    serverType: "http",
    rootDirectory: "/srv",
    bindHost: "127.0.0.1",
    port: 8080,
    autoStart: false,
    readOnly: true,
    ...over,
  };
}

function serverIn(status: ServerStatus): ServerState {
  return { serverId: "s", status, error: "why", stats: STATS };
}

const ids = (model: ServiceModel) => model.actions.map((a) => a.id);
const TAIL: ServiceActionId[] = ["duplicate", "delete"];

describe("what a tunnel offers in each state (#6028)", () => {
  it.each<[TunnelStatus, ServiceActionId[]]>([
    ["disconnected", ["start", "edit", ...TAIL]],
    ["waiting", ["stopWaiting", "edit", ...TAIL]],
    ["connecting", ["stop", "edit", ...TAIL]],
    ["connected", ["stop", "copyAddress", "edit", "restart", ...TAIL]],
    ["reconnecting", ["stop", "edit", ...TAIL]],
    ["stopping", ["stop", "edit", ...TAIL]],
    ["error", ["retry", "edit", ...TAIL]],
    ["missingConnection", ["edit", ...TAIL]],
    ["notReachable", ["stop", "edit", ...TAIL]],
  ])("%s", (status, actions) => {
    expect(ids(tunnelModel(tunnel(), tunnelIn(status), CONTEXT))).toEqual(actions);
  });
});

describe("what a file server offers in each state (#6028)", () => {
  it.each<[ServerStatus, ServiceActionId[]]>([
    ["stopped", ["start", "activity", "edit", ...TAIL]],
    ["waiting", ["stopWaiting", "activity", "edit", ...TAIL]],
    ["starting", ["stop", "activity", "edit", ...TAIL]],
    ["running", ["stop", "copyAddress", "openInBrowser", "activity", "edit", "restart", ...TAIL]],
    ["stopping", ["stop", "activity", "edit", ...TAIL]],
    ["error", ["retry", "activity", "edit", ...TAIL]],
    ["notReachable", ["stop", "activity", "edit", ...TAIL]],
  ])("%s", (status, actions) => {
    expect(ids(fileServerModel(server(), serverIn(status), CONTEXT))).toEqual(actions);
  });

  it("only a web server that opens here is opened in a browser", () => {
    const offers = (over: Partial<EmbeddedServerConfig>) =>
      ids(fileServerModel(server(over), serverIn("running"), CONTEXT)).includes("openInBrowser");
    expect(offers({})).toBe(true);
    expect(offers({ serverType: "ftp" })).toBe(false);
    expect(offers({ serverType: "tftp" })).toBe(false);
    // On the agent's localhost: the browser here would open something else.
    expect(offers({ host: EDGE })).toBe(false);
    expect(offers({ host: EDGE, bindHost: "0.0.0.0" })).toBe(true);
  });
});

describe("actions are the same for both kinds", () => {
  const running = [
    tunnelModel(tunnel(), tunnelIn("connected"), CONTEXT),
    fileServerModel(server(), serverIn("running"), CONTEXT),
  ];

  it("in one order", () => {
    for (const model of running) {
      const order = ids(model).map((id) => SERVICE_ACTION_ORDER.indexOf(id));
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(order).not.toContain(-1);
    }
  });

  it("with the same words, but for what a restart of each is called", () => {
    const [tunnelActions, serverActions] = running.map(
      (model) => new Map(model.actions.map((a) => [a.id, a.label]))
    );
    for (const [id, label] of tunnelActions) {
      if (id === "restart") continue;
      expect(serverActions.get(id), id).toBe(label);
    }
    expect(tunnelActions.get("restart")).toBe("Reconnect");
    expect(serverActions.get("restart")).toBe("Restart");
  });

  it("with the same keys", () => {
    for (const model of running) {
      const keys = new Map(model.actions.map((a) => [a.id, a.shortcut]));
      expect(keys.get("stop")).toBe("Space");
      expect(keys.get("edit")).toBe("Enter");
      expect(keys.get("delete")).toBe("Delete");
    }
  });
});

describe("what it is and where it runs", () => {
  it.each<[TunnelType, string]>([
    [LOCAL, "Reach something on the SSH server's side"],
    [remote(""), "Let the SSH server reach something here"],
    [DYNAMIC, "SOCKS5 proxy through the SSH server"],
  ])("a tunnel in plain words", (tunnelType, what) => {
    const model = tunnelModel(tunnel({ tunnelType }), undefined, CONTEXT);
    expect(model.what).toBe(what);
    // Here is the rule, so the line does not say it.
    expect(model.kindLine).toBe(what);
    expect(model.where.label).toBe("this computer");
    expect(model.state).toBe("stopped");
  });

  it.each([
    ["http", "Open a folder in a browser"],
    ["ftp", "Upload and download files"],
    ["tftp", "Give files to a device"],
  ] as const)("a file server in plain words (%s)", (serverType, what) => {
    const model = fileServerModel(server({ serverType, host: EDGE }), undefined, CONTEXT);
    expect(model.kindLine).toBe(`${what} · agent Edge box`);
    expect(model.where.agentId).toBe("edge");
  });

  it("names a machine it cannot name", () => {
    const gone = { kind: "agent", agentId: "gone" } as const;
    expect(fileServerModel(server({ host: gone }), undefined, CONTEXT).where.label).toBe(
      "a removed agent"
    );
    const unreadable = { kind: "cluster" } as never;
    const unknown = tunnelModel(tunnel({ host: unreadable }), undefined, CONTEXT);
    expect(unknown.where.label).toBe("an unknown machine");
    expect(unknown.kindLine).toContain("· an unknown machine");
  });
});

describe("state, reason and next step", () => {
  it("says why while it waits, stops, fails or cannot be reached", () => {
    for (const status of ["waiting", "stopping", "error", "notReachable"] as const) {
      expect(tunnelModel(tunnel(), tunnelIn(status), CONTEXT).reason).toBe("why");
      expect(fileServerModel(server(), serverIn(status), CONTEXT).reason).toBe("why");
    }
    expect(tunnelModel(tunnel(), tunnelIn("connected"), CONTEXT).reason).toBeUndefined();
    expect(fileServerModel(server(), serverIn("stopped"), CONTEXT).reason).toBeUndefined();
  });

  it("a deleted SSH connection says so and offers another", () => {
    const model = tunnelModel(tunnel(), tunnelIn("missingConnection"), CONTEXT);
    expect(model.reason).toBe("Its SSH connection was deleted.");
    expect(model.nextStep).toEqual({ id: "chooseConnection", label: "Choose connection" });
    expect(tunnelModel(tunnel(), tunnelIn("error"), CONTEXT).nextStep).toBeUndefined();
  });

  it("counts only while it runs", () => {
    const counters = { sent: 1, received: 2, active: 3, total: 4 };
    expect(tunnelModel(tunnel(), tunnelIn("connected"), CONTEXT).counters).toEqual(counters);
    expect(fileServerModel(server(), serverIn("running"), CONTEXT).counters).toEqual(counters);
    expect(tunnelModel(tunnel(), tunnelIn("notReachable"), CONTEXT).counters).toBeUndefined();
    expect(fileServerModel(server(), serverIn("error"), CONTEXT).counters).toBeUndefined();
  });
});

describe("the address, only while it runs", () => {
  const of = (tunnelType: TunnelType, over: Partial<TunnelConfig> = {}, state = {}) =>
    tunnelModel(tunnel({ tunnelType, ...over }), tunnelIn("connected", state), CONTEXT).address;

  it.each<TunnelStatus>([
    "disconnected",
    "waiting",
    "connecting",
    "reconnecting",
    "stopping",
    "error",
    "missingConnection",
    "notReachable",
  ])("there is none for a tunnel that is %s", (status) => {
    expect(tunnelModel(tunnel(), tunnelIn(status), CONTEXT).address).toBeUndefined();
  });

  it.each<ServerStatus>(["stopped", "waiting", "starting", "stopping", "error", "notReachable"])(
    "there is none for a file server that is %s",
    (status) => {
      expect(fileServerModel(server(), serverIn(status), CONTEXT).address).toBeUndefined();
    }
  );

  it("of a local tunnel here", () => {
    expect(of(LOCAL)?.text).toBe("localhost:5432");
  });

  it("of a local tunnel on an agent, as the agent bound it", () => {
    expect(of(LOCAL, { host: EDGE })?.text).toBe("localhost:5432 on Edge box");
    expect(of(LOCAL, { host: EDGE }, { boundAddress: "127.0.0.1:40001" })?.copy).toBe(
      "localhost:40001"
    );
    expect(of(LOCAL, { host: EDGE }, { boundAddress: "0.0.0.0:5432" })?.text).toBe(
      "edge.example:5432"
    );
    expect(of(LOCAL, { host: EDGE }, { boundAddress: "?" })?.copy).toBe("localhost:5432");
  });

  it("of a remote tunnel, on the SSH server", () => {
    expect(of(remote("localhost"))).toEqual({
      text: "localhost:9000 on shop-web",
      copy: "localhost:9000",
      on: "shop-web",
    });
    expect(of(remote("0.0.0.0"))?.text).toBe("shop.example:9000");
    // The agent that hosts it changes nothing about where it listens.
    expect(of(remote("localhost"), { host: EDGE })?.on).toBe("shop-web");
    expect(of(remote("localhost"), { sshConnectionId: "gone" })?.on).toBe("SSH server");
  });

  it("of a dynamic tunnel, as a proxy", () => {
    expect(of(DYNAMIC)?.copy).toBe("socks5://localhost:1080");
  });

  it("of a file server", () => {
    const at = (over: Partial<EmbeddedServerConfig>) =>
      fileServerModel(server(over), serverIn("running"), CONTEXT).address?.text;
    expect(at({})).toBe("http://localhost:8080");
    expect(at({ bindHost: "0.0.0.0" })).toBe("http://192.168.1.20:8080");
    expect(at({ serverType: "ftp", port: 2121 })).toBe("ftp://localhost:2121");
    expect(at({ serverType: "tftp", port: 6969, bindHost: "10.0.0.2" })).toBe(
      "tftp://10.0.0.2:6969"
    );
    expect(at({ host: EDGE })).toBe("http://localhost:8080 on Edge box");
    expect(at({ host: EDGE, bindHost: "0.0.0.0" })).toBe("http://edge.example:8080");
    expect(at({ host: { kind: "agent", agentId: "nohost" }, bindHost: "0.0.0.0" })).toBe(
      "http://localhost:8080 on Lab"
    );
  });
});
