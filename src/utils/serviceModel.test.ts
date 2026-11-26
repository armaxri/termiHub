import { describe, expect, it } from "vitest";
import type { SavedConnection } from "@/types/connection";
import type { EmbeddedServerConfig, ServerState, ServerStatus } from "@/types/embeddedServer";
import type { ServiceCause } from "@/types/generated/ServiceCause";
import type { TunnelConfig, TunnelState, TunnelStatus, TunnelType } from "@/types/tunnel";
import {
  fileServerModel,
  SERVICE_ACTION_ORDER,
  serviceCounts,
  tunnelModel,
  withoutAgent,
  type ServiceActionId,
  type ServiceContext,
  type ServiceModel,
} from "./serviceModel";
import type { PairStatus } from "./tunnelChain";

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
    ["connected", ["stop", "restart", "copyAddress", "edit", ...TAIL]],
    ["reconnecting", ["stop", "edit", ...TAIL]],
    ["stopping", ["edit", ...TAIL]],
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
    ["running", ["stop", "restart", "copyAddress", "openInBrowser", "activity", "edit", ...TAIL]],
    ["stopping", ["activity", "edit", ...TAIL]],
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

  it("with the same words", () => {
    const [tunnelActions, serverActions] = running.map(
      (model) => new Map(model.actions.map((a) => [a.id, a.label]))
    );
    for (const [id, label] of tunnelActions) expect(serverActions.get(id), id).toBe(label);
    expect(tunnelActions.get("restart")).toBe("Restart");
  });

  it("and what the run button does is never two things under one name", () => {
    const run = (status: TunnelStatus) =>
      tunnelModel(tunnel(), tunnelIn(status), CONTEXT).actions[0].label;
    expect(run("connected")).toBe("Stop");
    expect(run("connecting")).toBe("Cancel start");
    expect(run("waiting")).toBe("Cancel waiting");
    expect(run("disconnected")).toBe("Start");
    expect(run("error")).toBe("Retry");
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
  it.each<[TunnelType, string, string]>([
    [LOCAL, "Reach db through shop-web", "Local"],
    [remote(""), "Let shop-web reach this computer", "Remote"],
    [DYNAMIC, "Browse through shop-web (SOCKS5)", "Dynamic"],
  ])("a tunnel by the names of its ends", (tunnelType, what, technical) => {
    const model = tunnelModel(tunnel({ tunnelType }), undefined, CONTEXT);
    expect(model.what).toBe(what);
    expect(model.technical).toBe(technical);
    expect(model.where.label).toBe("this computer");
    expect(model.state).toBe("stopped");
  });

  it("a tunnel whose ends are elsewhere", () => {
    const onEdge = tunnelModel(tunnel({ tunnelType: remote(""), host: EDGE }), undefined, CONTEXT);
    expect(onEdge.what).toBe("Let shop-web reach that machine");
    const gone = tunnelModel(tunnel({ sshConnectionId: "gone" }), undefined, CONTEXT);
    expect(gone.what).toBe("Reach db through the SSH server");
    const at = (tunnelType: TunnelType) =>
      tunnelModel(tunnel({ tunnelType }), undefined, CONTEXT).what;
    // The server itself is the target.
    for (const remoteHost of ["localhost", "127.0.0.1", "::1", " "]) {
      const own = { ...LOCAL.config, remoteHost } as never;
      expect(at({ type: "local", config: own })).toBe("Reach something on shop-web");
    }
    const nas = { ...remote("").config, localHost: "nas" } as never;
    expect(at({ type: "remote", config: nas })).toBe("Let shop-web reach nas");
  });

  it.each([
    ["http", true, "Open a folder in a browser", "HTTP"],
    ["http", false, "Open a folder in a browser", "HTTP"],
    ["ftp", true, "Download only", "FTP"],
    ["ftp", false, "Download and upload", "FTP"],
    ["tftp", true, "Give files to a device", "TFTP"],
    ["tftp", false, "Give and receive files", "TFTP"],
  ] as const)("a file server as it is set (%s, %s)", (serverType, readOnly, what, technical) => {
    const model = fileServerModel(server({ serverType, readOnly }), undefined, CONTEXT);
    expect(model.what).toBe(what);
    expect(model.technical).toBe(technical);
  });

  it("names a machine it cannot name", () => {
    const gone = { kind: "agent", agentId: "gone" } as const;
    expect(fileServerModel(server({ host: gone }), undefined, CONTEXT).where.label).toBe(
      "a removed agent"
    );
    const unreadable = { kind: "cluster" } as never;
    const unknown = tunnelModel(tunnel({ host: unreadable }), undefined, CONTEXT);
    expect(unknown.where.label).toBe("an unknown machine");
    const edge = fileServerModel(server({ host: EDGE }), undefined, CONTEXT);
    expect(edge.where).toMatchObject({ name: "Edge box", agentId: "edge" });
  });
});

describe("uploads that anyone may make (S-002)", () => {
  const OPEN = { bindHost: "0.0.0.0", readOnly: false };
  const risk = (over: Partial<EmbeddedServerConfig>, status: ServerStatus = "running") =>
    fileServerModel(server(over), serverIn(status), CONTEXT).risk;
  const signedIn = { type: "credentials", username: "u", password: "" } as const;

  it("are said of a running server that is open to others", () => {
    const here = "Anyone on your network can upload";
    expect(risk({ serverType: "ftp", ...OPEN })).toBe(here);
    expect(risk({ serverType: "ftp", ...OPEN, ftpAuth: { type: "anonymous" } })).toBe(here);
    expect(risk({ serverType: "tftp", ...OPEN })).toBe(here);
    expect(risk({ serverType: "tftp", ...OPEN, host: EDGE })).toBe(
      "Anyone who reaches that machine can upload"
    );
  });

  it("are said even when its address is not known", () => {
    const noNetwork = { ...CONTEXT, networkAddress: undefined };
    const model = fileServerModel(
      server({ serverType: "ftp", ...OPEN }),
      serverIn("running"),
      noNetwork
    );
    expect(model.address?.copy).toBeUndefined();
    expect(model.risk).toBeDefined();
    // Nothing to copy or open then.
    expect(ids(model)).not.toContain("copyAddress");
    const web = fileServerModel(server({ ...OPEN }), serverIn("running"), noNetwork);
    expect(ids(web)).not.toContain("openInBrowser");
  });

  it.each<[string, Partial<EmbeddedServerConfig>, ServerStatus?]>([
    ["download only", { serverType: "ftp", ...OPEN, readOnly: true }],
    ["a web server", { serverType: "http", ...OPEN }],
    ["with a sign-in", { serverType: "ftp", ...OPEN, ftpAuth: signedIn }],
    ["private", { serverType: "tftp", ...OPEN, bindHost: "127.0.0.1" }],
    ["not running", { serverType: "tftp", ...OPEN }, "stopped"],
  ])("are not a risk: %s", (_why, over, status) => {
    expect(risk(over, status)).toBeUndefined();
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

  const steps = (model: ServiceModel) => model.nextSteps.map((step) => step.label);

  it("a deleted SSH connection says so and offers another", () => {
    const model = tunnelModel(tunnel(), tunnelIn("missingConnection"), CONTEXT);
    expect(model.reason).toBe("Its SSH connection was deleted.");
    expect(model.nextSteps).toEqual([{ id: "chooseConnection", label: "Choose connection" }]);
    expect(tunnelModel(tunnel(), tunnelIn("error"), CONTEXT).nextSteps).toEqual([]);
  });

  it.each<[TunnelStatus, ServiceCause | undefined, string[]]>([
    ["error", "portInUse", ["Use 5433", "Edit"]],
    ["error", "agentOffline", ["Connect agent"]],
    ["waiting", "agentOffline", ["Connect agent"]],
    ["notReachable", "agentOffline", ["Connect agent"]],
    ["stopping", "agentOffline", ["Keep running", "Connect agent"]],
    ["notReachable", "agentSilent", ["Check again"]],
    ["waiting", "storeLocked", ["Unlock"]],
    ["error", "storeLocked", ["Unlock"]],
    ["error", "connection", ["Edit connection"]],
    ["reconnecting", undefined, ["Retry now"]],
    ["error", "other", []],
    ["error", undefined, []],
    ["notReachable", undefined, []],
    // A state that says no reason needs no remedy.
    ["connected", "agentOffline", []],
    ["disconnected", "portInUse", []],
  ])("a tunnel that is %s because of %s offers %s", (status, cause, expected) => {
    const host = cause === "agentOffline" ? EDGE : undefined;
    const model = tunnelModel(tunnel({ host }), tunnelIn(status, { cause }), CONTEXT);
    expect(steps(model)).toEqual(expected);
  });

  it("the same for a file server", () => {
    const offered = (cause: ServiceCause, over: Partial<EmbeddedServerConfig> = {}) =>
      steps(fileServerModel(server(over), { ...serverIn("error"), cause }, CONTEXT));
    expect(offered("portInUse")).toEqual(["Use 8081", "Edit"]);
    expect(offered("agentOffline", { host: EDGE })).toEqual(["Connect agent"]);
    expect(offered("storeLocked")).toEqual(["Unlock"]);
  });

  it("offers a port that no other service here is set to", () => {
    const usedPorts = new Set([8081, 8082]);
    const at = (port: number) =>
      fileServerModel(
        server({ port }),
        { ...serverIn("error"), cause: "portInUse" },
        { ...CONTEXT, usedPorts }
      ).nextSteps;
    expect(at(8080)[0]).toEqual({ id: "usePort", label: "Use 8083", port: 8083 });
    // There is none after the last.
    expect(at(65535).map((step) => step.id)).toEqual(["edit"]);
  });

  it("a port on another machine is not this computer's to change", () => {
    const state = tunnelIn("error", { cause: "portInUse" });
    expect(steps(tunnelModel(tunnel({ host: EDGE }), state, CONTEXT))).toEqual(["Edit"]);
    const away = { ...serverIn("error"), cause: "portInUse" } as const;
    expect(steps(fileServerModel(server({ host: EDGE }), away, CONTEXT))).toEqual(["Edit"]);
    const onServer = tunnel({ tunnelType: remote("") });
    expect(steps(tunnelModel(onServer, state, CONTEXT))).toEqual(["Edit"]);
  });

  it("only an agent that can be connected is offered", () => {
    const away = tunnelIn("notReachable", { cause: "agentOffline" });
    const gone = { kind: "agent", agentId: "gone" } as const;
    expect(steps(tunnelModel(tunnel({ host: gone }), away, CONTEXT))).toEqual(["Choose machine"]);
    for (const [connectionState, offered] of [
      ["disconnected", true],
      ["connecting", false],
      ["reconnecting", false],
      ["connected", false],
    ] as const) {
      const agents = [{ ...CONTEXT.agents[0], connectionState }];
      const model = tunnelModel(tunnel({ host: EDGE }), away, { ...CONTEXT, agents });
      expect(steps(model), connectionState).toEqual(offered ? ["Connect agent"] : []);
    }
  });

  it("a stop the agent has not got is pending, not under way", () => {
    const owed = tunnelModel(
      tunnel({ host: EDGE }),
      tunnelIn("stopping", { cause: "agentOffline" }),
      CONTEXT
    );
    expect(owed.stateLabel).toBe("Stop pending");
    expect(owed.dot).toMatchObject({ label: "Stop pending", title: "Stop pending", pulse: false });
    const closing = tunnelModel(tunnel(), tunnelIn("stopping"), CONTEXT);
    expect(closing.stateLabel).toBe("Stopping");
    expect(closing.dot).toMatchObject({ label: "Stopping", pulse: true });
  });

  it("one half of a chained pair says whether it can be used here", () => {
    const parent = (status: PairStatus) =>
      tunnelModel(tunnel({ host: EDGE }), tunnelIn("connected"), CONTEXT, {
        role: "parent",
        status,
      });
    expect(parent("degraded")).toMatchObject({
      stateLabel: "Running",
      reason: "Does not work on this computer, see below.",
      dot: { tone: "warning" },
    });
    expect(ids(parent("degraded"))).not.toContain("copyAddress");
    expect(ids(parent("connected"))).toContain("copyAddress");
    for (const status of ["connected", "connecting", "none"] as const) {
      expect(parent(status).reason, status).toBeUndefined();
      expect(parent(status).dot.tone, status).toBe("success");
    }
    // The other half says its own reason.
    const broken = tunnelModel(tunnel(), tunnelIn("error"), CONTEXT, {
      role: "hop",
      status: "degraded",
    });
    expect(broken).toMatchObject({ reason: "why", dot: { tone: "error" } });
    const hop = (name: string) =>
      tunnelModel(tunnel({ name }), tunnelIn("connected"), CONTEXT, {
        role: "hop",
        status: "connected",
      });
    expect(hop("Shop database (hop on this computer)").name).toBe("On this computer");
    expect(hop("My own name").name).toBe("My own name");
    expect(hop("My own name").what).toBe("Brings it to this computer");
    expect(hop("x (hop on this computer)").address).toMatchObject({
      copy: "localhost:5432",
      reach: "only this computer",
    });
  });

  it("a service on a removed agent is never green (T-007)", () => {
    const gone = { kind: "agent", agentId: "gone" } as const;
    const models = [
      tunnelModel(tunnel({ host: gone }), tunnelIn("connected"), CONTEXT),
      fileServerModel(server({ host: gone }), serverIn("running"), CONTEXT),
    ];
    for (const model of models) {
      expect(model).toMatchObject({
        state: "notReachable",
        stateLabel: "Not reachable",
        health: "notKnown",
        reason: "Its agent was removed from termiHub. It may still run there.",
        address: undefined,
        counters: undefined,
      });
      expect(steps(model)).toEqual(["Choose machine"]);
      expect(ids(model)).not.toContain("restart");
    }
    // Before the agents are known, none of them is missing.
    const early = { ...CONTEXT, agents: [], agentsKnown: false };
    const model = tunnelModel(tunnel({ host: gone }), tunnelIn("connected"), early);
    expect(model.state).toBe("running");
    expect(model.where.label).toBe("an agent");
  });

  it("the password is part of who reaches it (T-004)", () => {
    const signIn = { type: "credentials", username: "u", password: "" } as const;
    const reach = (over: Partial<EmbeddedServerConfig>) =>
      fileServerModel(server(over), serverIn("running"), CONTEXT).address?.reach;
    const open = { bindHost: "0.0.0.0" };
    const ftp = { ...open, serverType: "ftp", ftpAuth: signIn } as const;
    const web = { ...open, httpAuth: { username: "u", password: "" } };
    expect(reach(ftp)).toBe("anyone on your network with the password");
    expect(reach(web)).toBe("anyone on your network with the password");
    expect(reach({ ...ftp, host: EDGE })).toBe(
      "anyone who reaches that machine, with the password"
    );
    expect(reach(open)).toBe("anyone on your network");
    // An FTP sign-in left over says nothing about the web server.
    expect(reach({ ...open, ftpAuth: signIn })).toBe("anyone on your network");
    expect(reach({ ...web, bindHost: "127.0.0.1" })).toBe("only this computer");
    // Why there is no address is said either way.
    const offline = { ...CONTEXT, networkAddress: undefined };
    const unknown = fileServerModel(server(ftp), serverIn("running"), offline).address;
    expect(unknown?.reach).toContain("no network address now");
  });

  it("a list says how many run, and how many are in each state that is not on or off", () => {
    const list = (...models: ServiceModel[]) => serviceCounts(models).map((c) => c.label);
    const at = (status: TunnelStatus, cause?: ServiceCause) =>
      tunnelModel(tunnel(), tunnelIn(status, { cause }), CONTEXT);
    expect(list(at("connected"), at("disconnected"), at("connecting"), at("stopping"))).toEqual([
      "1 of 4 running",
    ]);
    expect(
      list(
        at("waiting"),
        at("reconnecting"),
        at("notReachable"),
        at("stopping", "agentOffline"),
        at("error"),
        at("missingConnection")
      )
    ).toEqual(["0 of 6 running", "2 errors", "2 not known", "1 reconnecting", "1 waiting"]);
    expect(list(at("error"))).toEqual(["0 of 1 running", "1 error"]);
    // Not errors of their own when all of them only need a connection.
    const bare = at("missingConnection");
    expect(list(bare)).toEqual(["0 of 1 running", "1 needs a connection"]);
    expect(list(bare, bare)).toEqual(["0 of 2 running", "2 need a connection"]);
  });

  it("a taken port is said with the service that has it (#6076)", () => {
    const portHolders = new Map([[8080, { id: "other", name: "Release builds" }]]);
    const taken = {
      ...serverIn("error"),
      error: "Port 8080 is in use.",
      cause: "portInUse" as const,
    };
    const says = (context: ServiceContext, over: Partial<EmbeddedServerConfig> = {}) =>
      fileServerModel(server({ port: 8080, ...over }), taken, context).reason;
    expect(says({ ...CONTEXT, portHolders })).toBe('Port 8080 is used by "Release builds".');
    expect(says(CONTEXT)).toBe("Port 8080 is in use.");
    expect(says({ ...CONTEXT, portHolders }, { port: 9 })).toBe("Port 8080 is in use.");
    // Only when that is why, and while it did not start.
    const other = { ...taken, cause: "other" as const };
    expect(fileServerModel(server({ port: 8080 }), other, { ...CONTEXT, portHolders }).reason).toBe(
      "Port 8080 is in use."
    );
    const open = { ...serverIn("running"), cause: "portInUse" as const };
    expect(
      fileServerModel(server({ port: 8080 }), open, { ...CONTEXT, portHolders }).reason
    ).toBeUndefined();
    // Another machine's port.
    const there = { host: EDGE } as Partial<EmbeddedServerConfig>;
    expect(says({ ...CONTEXT, portHolders }, there)).toBe("Port 8080 is in use.");
  });

  it("a server for devices says when none can reach it (#6076)", () => {
    const tftp = (bindHost: string, over: Partial<EmbeddedServerConfig> = {}) =>
      fileServerModel(
        server({ serverType: "tftp", bindHost, port: 6969, ...over }),
        serverIn("running"),
        { ...CONTEXT, networkAddress: "192.168.1.20" }
      );
    const here = tftp("127.0.0.1");
    expect(here.address?.reach).toBe("Only this computer, no device can reach it.");
    expect(here.addressStep).toEqual({ id: "letReach", label: "Let devices reach it" });
    const there = tftp("127.0.0.1", { host: EDGE } as Partial<EmbeddedServerConfig>);
    expect(there.address?.reach).toBe("Only that machine, no device can reach it.");
    const open = tftp("0.0.0.0");
    expect(open.address?.reach).toBe("anyone on your network");
    expect(open.addressStep).toBeUndefined();
    const web = fileServerModel(server({ bindHost: "127.0.0.1" }), serverIn("running"), CONTEXT);
    expect(web.address?.reach).toBe("only this computer");
    expect(web.addressStep).toBeUndefined();
  });

  it("under its agent's line a pending stop says what will happen (#6076)", () => {
    const pending = tunnelModel(
      tunnel({ host: EDGE }),
      tunnelIn("stopping", { cause: "agentOffline", error: "Its agent is offline. Long." }),
      CONTEXT
    );
    const short = withoutAgent(pending);
    // Its state and the agent's line say it (V-004).
    expect(short.reason).toBeUndefined();
    expect(short.stateLabel).toBe("Stop pending");
    expect(steps(short)).toEqual(["Keep running"]);
  });

  it("a folder shared for this session says so, unless it has a description (slice 12)", () => {
    const shared = fileServerModel(server({ temporary: true }), undefined, CONTEXT);
    expect(shared.description).toBe("Until termiHub closes");
    const own = fileServerModel(
      server({ temporary: true, description: "Docs" }),
      undefined,
      CONTEXT
    );
    expect(own.description).toBe("Docs");
    expect(fileServerModel(server(), undefined, CONTEXT).description).toBeUndefined();
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
    expect(of(LOCAL)).toMatchObject({ copy: "localhost:5432", reach: "only this computer" });
  });

  it("of a local tunnel on an agent, as the agent bound it", () => {
    expect(of(LOCAL, { host: EDGE })).toMatchObject({
      copy: "localhost:5432",
      on: "Edge box",
      reach: "only on that machine",
    });
    expect(of(LOCAL, { host: EDGE }, { boundAddress: "127.0.0.1:40001" })?.copy).toBe(
      "localhost:40001"
    );
    expect(of(LOCAL, { host: EDGE }, { boundAddress: "0.0.0.0:5432" })).toMatchObject({
      copy: "edge.example:5432",
      reach: "anyone who reaches that machine",
    });
    expect(of(LOCAL, { host: EDGE }, { boundAddress: "?" })?.copy).toBe("localhost:5432");
  });

  it("of a remote tunnel, on the SSH server", () => {
    expect(of(remote("localhost"))).toMatchObject({
      copy: "localhost:9000",
      on: "shop-web",
      reach: "only on shop-web",
    });
    expect(of(remote("0.0.0.0"))).toMatchObject({
      copy: "shop.example:9000",
      // Only its SSH server knows (#6034).
      reach: "anyone who reaches shop-web, if its SSH server allows it",
    });
    // An address nobody knows is said as such.
    expect(of(remote("0.0.0.0"), { sshConnectionId: "gone" })?.reach).toContain(
      "address is not known"
    );
    // The agent that hosts it changes nothing about where it listens.
    expect(of(remote("localhost"), { host: EDGE })?.on).toBe("shop-web");
    expect(of(remote("localhost"), { sshConnectionId: "gone" })?.on).toBe("the SSH server");
  });

  it("of a dynamic tunnel, as a proxy", () => {
    expect(of(DYNAMIC)?.copy).toBe("socks5://localhost:1080");
  });

  it("of a file server", () => {
    const at = (over: Partial<EmbeddedServerConfig>) => {
      const { address } = fileServerModel(server(over), serverIn("running"), CONTEXT);
      return address?.on ? `${address.copy} on ${address.on}` : address?.copy;
    };
    expect(at({})).toBe("http://localhost:8080");
    expect(at({ bindHost: "0.0.0.0" })).toBe("http://192.168.1.20:8080");
    expect(at({ serverType: "ftp", port: 2121 })).toBe("ftp://localhost:2121");
    expect(at({ serverType: "tftp", port: 6969, bindHost: "10.0.0.2" })).toBe(
      "tftp://10.0.0.2:6969"
    );
    expect(at({ host: EDGE })).toBe("http://localhost:8080 on Edge box");
    expect(at({ host: EDGE, bindHost: "0.0.0.0" })).toBe("http://edge.example:8080");
    expect(at({ host: { kind: "agent", agentId: "nohost" }, bindHost: "0.0.0.0" })).toBeUndefined();
  });
});
