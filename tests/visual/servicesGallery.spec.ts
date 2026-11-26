/**
 * One named screenshot per service state and kind (#6028), at the minimum window
 * and the usual one, in dark and light, for a usability review by someone who did
 * not build them.
 *
 * Run `pnpm exec playwright test -c tests/visual/playwright.config.ts servicesGallery`.
 * The shots land in `test-results/screens/services/`, named
 * `<surface>--<state>--<window>--<theme>.png`, with `index.json` beside them: what the
 * user wants to do in each. Every shot is audited for layout, and every row is
 * checked: nothing on it is cut, its state is a word and not only a colour, and
 * the address is there exactly while it runs.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import type { VisualScenario } from "./harness/mockBackend";
import type { VisualHandle } from "./harness/visualHandle";
import { auditLayout } from "./layoutAudit";
import { SCREENS } from "./surfaces";
import { styledPrimitiveClasses } from "./uiClasses";

declare global {
  interface Window {
    __visual: VisualHandle;
  }
}

const STYLED_CLASSES = styledPrimitiveClasses();
const DIR = join(SCREENS, "services");
const WINDOWS = [
  { width: 800, height: 600 },
  { width: 1280, height: 800 },
];
const THEMES = ["dark", "light"];
const id = (testId: string) => `[data-testid="${testId}"]`;

/** Every state, and what the user wants to do there. */
const STATES = {
  "services--filled": "Tunnels and file servers together: which work right now, which need you?",
  "services--agent-offline": "An agent with five services is gone: what about them, and what now?",
  "services--closed": "Only the file servers matter now.",
  "services--new-menu": "You want to reach a database behind a server: start.",
  "services--new-tunnel": "The tunnel's editor after choosing what it is for.",
  "services--search": "Find the service that uses port 15003.",
  "services--search-word": 'Search for what it is: "file server".',
  "services--only-errors": "You pressed the errors: what is wrong, and how to see all again?",
  "services--stop-all": "Stop everything before you leave: what is cut off?",
  "services--open-connections": "What runs right now, of everything: stop the services?",
  "services--quit": "You quit while someone downloads: what stops?",
  "services--nothing": "You searched for something that is not there.",
  "services--empty": "There is no service yet: what is this for, and make one.",
  "services--palette": "Find the tunnels from the command palette.",
  "services--narrow": "The narrowest sidebar, both kinds.",
  "tunnels--stopped": "Find the tunnel you need and start it.",
  "tunnels--waiting": "Two tunnels have not started yet: why, and will they?",
  "tunnels--starting": "A tunnel was just started: is it there yet?",
  "tunnels--running": "The tunnel runs: what do you type to use it?",
  "tunnels--reconnecting": "The connection dropped: what happens now?",
  "tunnels--reconnecting-last": "It has tried nine times: what happens after this one?",
  "tunnels--stopping": "Stop was pressed while the agent is away: is it stopped?",
  "tunnels--error": "A tunnel did not start: why, and what now?",
  "tunnels--needs-connection": "A connection was deleted: what about its tunnel?",
  "tunnels--not-reachable": "The agent is gone: does the tunnel still run?",
  "tunnels--on-agent": "Tunnels on other machines: where can you use each?",
  "tunnels--chained": "A hop to this computer: does localhost work, and if not, what now?",
  "tunnels--chained-working": "A hop to this computer: does localhost work?",
  "tunnels--wide": "Tunnels that others can use: who, and where?",
  "tunnels--mixed-error": "Show only what has an error.",
  "tunnels--mixed": "Fifteen tunnels: which work right now, which need you?",
  "tunnels--tooltip": "What exactly does this tunnel do?",
  "tunnels--stop": "Stop a tunnel that is in use: what happens?",
  "tunnels--delete": "Delete a running tunnel: what happens?",
  "tunnels--edit": "Change the port of a tunnel.",
  "tunnels--narrow": "The narrowest sidebar, long names: read everything.",
  "tunnels--hover": "Change, copy or delete a running tunnel.",
  "tunnels--menu": "The same, from its menu.",
  "servers--shared": "A folder you shared for now: how long does it stay?",
  "servers--stopped": "Find the folder you share and start it.",
  "servers--waiting": "Two servers have not started yet: why, and will they?",
  "servers--starting": "A server was just started: is it there yet?",
  "servers--running": "The server runs: what do you tell the other person?",
  "servers--open": "Servers for others: what do you tell them, and who can upload?",
  "servers--open-unknown": "A server for the network, and no network: what do you tell them?",
  "servers--stopping": "Stop was pressed while the agent is away: is it stopped?",
  "servers--error": "A server did not start: why, and what now?",
  "servers--not-reachable": "The agent is gone: does the server still run?",
  "servers--on-agent": "Servers on other machines: where can others open each?",
  "servers--narrow": "The narrowest sidebar, long names: read everything.",
  "servers--hover": "Open, change or delete a running server.",
  "servers--menu": "The same, from its menu.",
  "servers--mixed": "Fifteen servers: which work right now, which need you?",
  "servers--tooltip": "What exactly does this server share?",
  "servers--stop": "Stop a server while somebody downloads: what happens?",
  "servers--delete": "Delete a running server: what happens?",
  "tunnel-editor--local": "Reach a database behind a server.",
  "tunnel-editor--remote": "Let a server reach your web app.",
  "tunnel-editor--dynamic": "Browse as if you were on the server's network.",
  "tunnel-editor--open": "The whole network may use your tunnel: do you see what that means?",
  "tunnel-editor--open-remote": "Colleagues of the server may reach your web app.",
  "tunnel-editor--missing": "Saving did nothing: what is missing?",
  "tunnel-editor--agent": "The tunnel runs on another machine: how do you use it here?",
  "tunnel-editor--kinds": "You took the wrong kind: change it.",
  "tunnel-editor--path": "Which way does it go?",
  "tunnel-editor--edit": "Change the port of a running tunnel.",
  "server-editor--http": "Make a folder open in a browser.",
  "server-editor--ftp": "Share a folder to upload and download files.",
  "server-editor--tftp": "Make a server that gives firmware to a switch.",
  "server-editor--port-taken": "The port you typed is one of your other servers'.",
  "server-editor--share":
    "You shared a folder from the file browser: who gets it, and for how long?",
  "server-editor--missing": "Saving did nothing: what is missing?",
  "server-editor--warning": "Others may upload without a password: do you see what that means?",
  "server-editor--sign-in": "Only people with the password may open it.",
  "server-editor--address": "It should be open on one address only.",
  "server-editor--agent": "The folder is on another machine.",
  "server-editor--kinds": "You took the wrong kind: change it.",
  "server-editor--edit": "Change the port of a running server.",
  "server-editor--unsaved": "You closed the tab with changes in it.",
  "activity--tunnel": "A tunnel runs: since when, how do you use it, how much went through?",
  "activity--tunnel-reconnecting": "The connection dropped: what has it tried so far?",
  "activity--tunnel-error": "It gave up: why, and what now?",
  "activity--tunnel-stopped": "It is stopped: what happened before?",
  "activity--server": "Who uses the server right now?",
  "activity--server-nobody": "Does anybody use the server?",
  "activity--server-unavailable": "The log cannot be read: does the server run, and what now?",
  "activity--log-full": "It changed many times: what happened last?",
  "activity--old-agent": "It runs on an old agent: what can you see?",
} as const;
type State = keyof typeof STATES;

const EDGE = "Edge gateway in the Frankfurt datacenter rack";
const ON_EDGE = { kind: "agent", agentId: "agent-edge" };
const STATS = { bytesSent: 2048, bytesReceived: 8192, activeConnections: 1, totalConnections: 3 };

/** The sentences the backend writes (src-tauri/src/agent_service.rs). */
const WHY = {
  agent: "Starts when its agent connects, until 14:32. After that, start it yourself.",
  store: "Starts when you unlock the credential store, until 14:32. After that, start it yourself.",
  stopping:
    "Its agent is offline. It may still run there; it will be stopped when the agent is back.",
  expired:
    "Not started: its agent was not connected within 30 minutes. Connect it, then start it again.",
  port: (port: number) => `Port ${port} is already in use on this computer.`,
  ssh: "Build Box refused the connection. Is its SSH server running?",
  away: "Its agent is offline. It may still run there; termiHub cannot tell.",
  silent: "Its agent did not answer the start. It may run there; termiHub keeps asking.",
  reconnecting: "Connection lost. Try 3 of 10 at 14:32:08.",
  last: "Connection lost. Try 10 of 10 at 14:32:08, then start it yourself.",
};
/** What goes with each, as the backend sends it. */
const AGENT = { cause: "agentOffline" };
const SILENT = { cause: "agentSilent" };
const STORE = { cause: "storeLocked" };
const PORT = { cause: "portInUse" };
const SSH = { cause: "connection" };

type Fields = Record<string, unknown>;

interface Row {
  id: string;
  name: string;
  type?: string;
  status: string;
  error?: string;
  over?: Fields;
  state?: Fields;
}

const LISTEN = { localHost: "127.0.0.1", localPort: 15432 };
const TUNNEL_TYPES: Record<string, unknown> = {
  local: { type: "local", config: { ...LISTEN, remoteHost: "db", remotePort: 5432 } },
  remote: {
    type: "remote",
    config: { remoteHost: "localhost", remotePort: 9000, localHost: "localhost", localPort: 3000 },
  },
  dynamic: { type: "dynamic", config: { ...LISTEN, localPort: 1080 } },
};

/** The three tunnel types in one status. */
const tunnelsIn = (status: string, error?: string, over?: Fields, state?: Fields): Row[] => [
  { id: "db", name: "Shop database", type: "local", status, error, over, state },
  { id: "web", name: "Show my web app", type: "remote", status, error, over, state },
  { id: "proxy", name: "Browse the office network", type: "dynamic", status, error, over, state },
];

/** The three kinds of file server in one status. */
const serversIn = (status: string, error?: string, over?: Fields, state?: Fields): Row[] => [
  { id: "web", name: "Release builds", type: "http", status, error, over, state },
  {
    id: "scans",
    name: "Scanner inbox",
    type: "ftp",
    status,
    error,
    // Scanners put files there, after signing in.
    over: {
      readOnly: false,
      ftpAuth: { type: "credentials", username: "scan", password: "" },
      ...over,
    },
    state,
  },
  { id: "boot", name: "Switch firmware", type: "tftp", status, error, over, state },
];

function data(tunnels: Row[], servers: Row[]): NonNullable<VisualScenario["serviceData"]> {
  const states = (rows: Row[], idKey: string) =>
    Object.fromEntries(
      rows.map(({ id, status, error, state }) => [
        id,
        { [idKey]: id, status, error, stats: STATS, ...state },
      ])
    );
  return {
    tunnels: {
      tunnels: tunnels.map(({ id, name, type, over }) => ({
        id,
        name,
        sshConnectionId: "Work/Build Box",
        tunnelType: TUNNEL_TYPES[type ?? "local"],
        autoStart: false,
        reconnectOnDisconnect: false,
        ...over,
      })),
      states: states(tunnels, "tunnelId"),
    },
    services: {
      servers: servers.map(({ id, name, type, over }) => ({
        id,
        name,
        serverType: type ?? "http",
        rootDirectory: "/srv/share",
        bindHost: "127.0.0.1",
        port: { http: 8080, ftp: 2121, tftp: 6969 }[type ?? "http"],
        autoStart: false,
        readOnly: true,
        ...over,
      })),
      states: states(servers, "serverId"),
    },
  };
}

const LONG = "Postgres on the production database replica in Frankfurt";
const WIDE = (port: number): Fields => ({
  tunnelType: {
    type: "local",
    config: { localHost: "0.0.0.0", localPort: port, remoteHost: "db", remotePort: 5432 },
  },
});
const onPort = (port: number, remoteHost = "db"): Fields => ({
  tunnelType: {
    type: "local",
    config: { localHost: "127.0.0.1", localPort: port, remoteHost, remotePort: 5432 },
  },
});

/** Fifteen names an administrator may have, most of them fine. */
const MIXED_NAMES = [
  "Orders database",
  "Grafana",
  "Kibana",
  "Office proxy",
  "Jenkins",
  "Wiki",
  "Build cache",
  "Customer portal",
  "Reporting database",
  "Mail relay",
  "Printer admin page",
  "Backup status",
  "Staging shop",
  "Legacy ERP",
  "Switch console",
];

/** The state of the nth of fifteen. */
function mixed(index: number, running: string, stopped: string): Partial<Row> {
  switch (index) {
    case 2:
      return { status: "error", error: WHY.port(15002), state: PORT };
    case 5:
      return { status: "waiting", error: WHY.store, state: STORE };
    case 8:
      return { status: "notReachable", error: WHY.away, over: { host: ON_EDGE }, state: AGENT };
    case 11:
      return { status: running, over: { host: ON_EDGE } };
    default:
      return { status: index % 3 === 1 ? stopped : running };
  }
}

const MIXED_TUNNELS: Row[] = MIXED_NAMES.map((name, index) => {
  const row = mixed(index, "connected", "disconnected");
  return {
    id: `m${index}`,
    name,
    type: "local",
    status: "disconnected",
    ...row,
    over: {
      ...onPort(15000 + index, name.toLowerCase().split(" ").pop()),
      ...row.over,
    },
  };
});
const MIXED_SERVERS: Row[] = MIXED_NAMES.map((name, index) => {
  const row = mixed(index, "running", "stopped");
  return {
    id: `m${index}`,
    name,
    type: ["http", "ftp", "tftp"][index % 3],
    status: "stopped",
    ...row,
    over: { port: 15000 + index, ...row.over },
  };
});

const TUNNEL_ROWS: Partial<Record<State, Row[]>> = {
  "tunnels--stopped": tunnelsIn("disconnected"),
  "tunnels--waiting": [
    ...tunnelsIn("waiting", WHY.agent, { host: ON_EDGE }, AGENT).slice(0, 1),
    { id: "bastion", name: "Behind a bastion", status: "waiting", error: WHY.store, state: STORE },
  ],
  "tunnels--starting": tunnelsIn("connecting"),
  "tunnels--running": tunnelsIn("connected"),
  "tunnels--reconnecting": tunnelsIn("reconnecting", WHY.reconnecting),
  "tunnels--reconnecting-last": tunnelsIn("reconnecting", WHY.last).slice(0, 1),
  "tunnels--stopping": tunnelsIn("stopping", WHY.stopping, { host: ON_EDGE }, AGENT),
  "tunnels--error": [
    ...tunnelsIn("error", WHY.ssh, undefined, SSH).slice(0, 1),
    {
      id: "late",
      name: "Metrics",
      status: "error",
      error: WHY.expired,
      over: { host: ON_EDGE },
      state: AGENT,
    },
    {
      id: "taken",
      name: "Grafana",
      status: "error",
      error: WHY.port(13000),
      over: onPort(13000),
      state: PORT,
    },
  ],
  "tunnels--needs-connection": tunnelsIn("missingConnection"),
  "tunnels--not-reachable": [
    ...tunnelsIn("notReachable", WHY.away, { host: ON_EDGE }, AGENT).slice(0, 2),
    {
      id: "un",
      name: "Grafana",
      status: "notReachable",
      error: WHY.silent,
      over: { host: ON_EDGE },
      state: SILENT,
    },
  ],
  "tunnels--on-agent": [
    {
      id: "there",
      name: "Only on the gateway",
      status: "connected",
      over: { host: ON_EDGE },
      state: { boundAddress: "127.0.0.1:15432", reachableFrom: "agentOnly" },
    },
    {
      id: "lan",
      name: "For its network",
      status: "connected",
      over: { host: ON_EDGE },
      state: { boundAddress: "0.0.0.0:15432", reachableFrom: "agentLan" },
    },
    { id: "here", name: "On this computer", status: "connected", over: onPort(15433) },
  ],
  "tunnels--chained": [
    {
      id: "parent",
      name: "Shop database",
      status: "connected",
      over: { host: ON_EDGE },
    },
    {
      id: "hop",
      name: "Shop database (hop on this computer)",
      status: "error",
      error: WHY.port(15432),
      over: { companionOf: "parent" },
      state: PORT,
    },
  ],
  "tunnels--chained-working": [
    { id: "parent", name: "Shop database", status: "connected", over: { host: ON_EDGE } },
    {
      id: "hop",
      name: "Shop database (hop on this computer)",
      status: "connected",
      over: { companionOf: "parent" },
    },
  ],
  "tunnels--wide": [
    { id: "lan", name: "For the office", status: "connected", over: WIDE(15432) },
    {
      id: "unknown",
      name: "On a removed agent",
      status: "connected",
      over: { host: { kind: "agent", agentId: "agent-gone" }, ...WIDE(15433) },
    },
  ],
  "tunnels--mixed": MIXED_TUNNELS,
  "tunnels--mixed-error": MIXED_TUNNELS,
  "tunnels--tooltip": tunnelsIn("connected"),
  "tunnels--stop": tunnelsIn("connected"),
  "tunnels--delete": tunnelsIn("connected"),
  "tunnels--edit": tunnelsIn("disconnected"),
  "tunnels--narrow": [
    {
      id: "l1",
      name: LONG,
      status: "connected",
      over: { host: ON_EDGE, description: "Read only" },
    },
    {
      id: "l2",
      name: LONG,
      status: "notReachable",
      error: WHY.away,
      over: { host: ON_EDGE },
      state: AGENT,
    },
    { id: "l3", name: "Proxy", type: "dynamic", status: "connected" },
  ],
  "tunnels--hover": tunnelsIn("connected"),
  "tunnels--menu": tunnelsIn("connected"),
};
const SERVER_ROWS: Partial<Record<State, Row[]>> = {
  "servers--stopped": serversIn("stopped"),
  "servers--shared": [
    {
      id: "shared",
      name: "Builds",
      type: "http",
      status: "running",
      over: { temporary: true, rootDirectory: "/home/ann/Builds", port: 8081 },
    },
    ...serversIn("running").slice(0, 1),
  ],
  "servers--waiting": [
    ...serversIn("waiting", WHY.agent, { host: ON_EDGE }, AGENT).slice(0, 1),
    { id: "pw", name: "With a password", status: "waiting", error: WHY.store, state: STORE },
  ],
  "servers--starting": serversIn("starting"),
  "servers--running": [
    ...serversIn("running"),
    {
      id: "wide",
      name: "For the team",
      status: "running",
      over: { bindHost: "0.0.0.0", port: 8081 },
    },
  ],
  "servers--open": [
    {
      id: "web",
      name: "Release builds",
      status: "running",
      over: { bindHost: "0.0.0.0" },
    },
    {
      id: "in",
      name: "Scanner inbox",
      type: "ftp",
      status: "running",
      over: { bindHost: "0.0.0.0", readOnly: false, ftpAuth: { type: "anonymous" } },
    },
    {
      id: "pw",
      name: "Contractor upload",
      type: "ftp",
      status: "running",
      over: {
        bindHost: "0.0.0.0",
        port: 2122,
        readOnly: false,
        ftpAuth: { type: "credentials", username: "c", password: "" },
      },
    },
    {
      id: "boot",
      name: "Switch backup",
      type: "tftp",
      status: "running",
      over: { bindHost: "0.0.0.0", readOnly: false, host: ON_EDGE },
    },
  ],
  "servers--open-unknown": [
    { id: "web", name: "Release builds", status: "running", over: { bindHost: "0.0.0.0" } },
  ],
  "servers--stopping": serversIn("stopping", WHY.stopping, { host: ON_EDGE }, AGENT),
  "servers--error": [
    {
      id: "web",
      name: "Release builds",
      status: "error",
      error: WHY.port(8080),
      state: PORT,
    },
    {
      id: "scans",
      name: "Scanner inbox",
      type: "ftp",
      status: "error",
      error: WHY.expired,
      over: { host: ON_EDGE },
      state: AGENT,
    },
  ],
  "servers--not-reachable": [
    ...serversIn("notReachable", WHY.away, { host: ON_EDGE }, AGENT).slice(0, 2),
    {
      id: "un",
      name: "Docs",
      status: "notReachable",
      error: WHY.silent,
      over: { host: ON_EDGE },
      state: SILENT,
    },
  ],
  "servers--on-agent": [
    { id: "there", name: "Only on the gateway", status: "running", over: { host: ON_EDGE } },
    {
      id: "lan",
      name: "For its network",
      status: "running",
      over: { host: ON_EDGE, bindHost: "0.0.0.0" },
    },
    { id: "here", name: "On this computer", status: "running", over: { port: 8081 } },
  ],
  "servers--mixed": MIXED_SERVERS,
  "servers--tooltip": serversIn("running"),
  "servers--stop": serversIn("running"),
  "servers--delete": serversIn("running"),
  "servers--narrow": [
    { id: "l1", name: LONG, status: "running", over: { host: ON_EDGE, description: "Read only" } },
    {
      id: "l2",
      name: LONG,
      status: "notReachable",
      error: WHY.away,
      over: { host: ON_EDGE },
      state: AGENT,
    },
    { id: "l3", name: "Boot", type: "tftp", status: "running", over: { bindHost: "0.0.0.0" } },
  ],
  "servers--hover": serversIn("running"),
  "servers--menu": serversIn("running"),
};

const request = (seq: number, client: string, path: string, bytes: number, status = "200") => ({
  seq,
  timestamp: `2026-11-25T10:0${seq}:12Z`,
  client,
  method: "GET",
  path,
  status,
  success: status === "200",
  bytes,
  durationMs: 12 * seq,
});
const NO_REQUESTS = {
  entries: [],
  latestSeq: 0,
  epoch: 0,
  dropped: 0,
  capacity: 500,
  stats: {
    activeConnections: 0,
    totalConnections: 0,
    bytesSent: 0,
    bytesReceived: 0,
    totalRequests: 0,
    errors: 0,
    topPaths: [],
    topClients: [],
    currentTransfers: [],
  },
};
/** Two clients, and one of them downloads. */
const REQUESTS = {
  ...NO_REQUESTS,
  latestSeq: 4,
  entries: [
    request(1, "192.168.1.31", "/", 2048),
    request(2, "192.168.1.31", "/termiHub-0.1.0.dmg", 48_000_000),
    request(3, "192.168.1.44", "/old.zip", 0, "404"),
    request(4, "192.168.1.44", "/", 2048),
  ],
  stats: {
    ...NO_REQUESTS.stats,
    activeConnections: 1,
    totalConnections: 5,
    bytesSent: 61_000_000,
    totalRequests: 4,
    errors: 1,
    topPaths: [
      { key: "/", count: 2 },
      { key: "/termiHub-0.1.0.dmg", count: 1 },
    ],
    topClients: [
      { key: "192.168.1.31", count: 2 },
      { key: "192.168.1.44", count: 2 },
    ],
    currentTransfers: [
      {
        id: 1,
        method: "GET",
        client: "192.168.1.44",
        path: "/termiHub-0.1.0.dmg",
        bytes: 13_000_000,
        startedAt: "2026-11-25T10:04:40Z",
      },
    ],
  },
};
const BOTH: { tunnels: Row[]; servers: Row[] } = {
  tunnels: [
    ...MIXED_TUNNELS.slice(0, 7),
    { id: "chain", name: "Shop database", status: "connected", over: { host: ON_EDGE } },
    {
      id: "hop",
      name: "Shop database (hop on this computer)",
      status: "connected",
      over: { companionOf: "chain", ...onPort(15432) },
    },
  ],
  servers: [
    ...serversIn("running"),
    {
      id: "wide",
      name: "For the team",
      status: "running",
      over: { bindHost: "0.0.0.0", port: 8081 },
    },
    { id: "taken", name: "Docs", status: "error", error: WHY.port(8080), state: PORT },
  ],
};
const OFFLINE: { tunnels: Row[]; servers: Row[] } = {
  tunnels: [
    { id: "ok", name: "Grafana", status: "connected", over: onPort(13000) },
    ...tunnelsIn("notReachable", WHY.away, { host: ON_EDGE }, AGENT),
    {
      id: "late",
      name: "Metrics",
      status: "waiting",
      error: WHY.agent,
      over: { host: ON_EDGE },
      state: AGENT,
    },
  ],
  servers: [
    ...serversIn("notReachable", WHY.away, { host: ON_EDGE }, AGENT).slice(0, 1),
    { id: "own", name: "Release builds here", status: "running", over: { port: 8082 } },
  ],
};
/** Both kinds at once, per state. */
const BOTH_ROWS: Partial<Record<State, { tunnels: Row[]; servers: Row[] }>> = {
  "services--filled": BOTH,
  "services--agent-offline": OFFLINE,
  "services--closed": BOTH,
  "services--new-menu": BOTH,
  "services--new-tunnel": BOTH,
  "services--search": BOTH,
  "services--search-word": BOTH,
  "services--only-errors": BOTH,
  "services--stop-all": BOTH,
  "services--quit": BOTH,
  "services--open-connections": BOTH,
  "services--nothing": BOTH,
  "services--palette": BOTH,
  "services--narrow": BOTH,
};

/** The service whose Activity a state shows, the first row (#6028, slice 9). */
const ACTIVITY_ROWS: Partial<Record<State, { tunnels: Row[]; servers: Row[] }>> = {
  "activity--tunnel": { tunnels: tunnelsIn("connected").slice(0, 1), servers: [] },
  "activity--tunnel-reconnecting": {
    tunnels: tunnelsIn("reconnecting", WHY.reconnecting).slice(0, 1),
    servers: [],
  },
  "activity--tunnel-error": {
    tunnels: tunnelsIn("error", WHY.ssh, undefined, SSH).slice(0, 1),
    servers: [],
  },
  "activity--tunnel-stopped": { tunnels: tunnelsIn("disconnected").slice(0, 1), servers: [] },
  "activity--server": {
    tunnels: [],
    servers: serversIn("running", undefined, { bindHost: "0.0.0.0" }).slice(0, 1),
  },
  "activity--server-nobody": { tunnels: [], servers: serversIn("running").slice(0, 1) },
  "activity--server-unavailable": { tunnels: [], servers: serversIn("running").slice(0, 1) },
  "activity--log-full": { tunnels: tunnelsIn("connected").slice(0, 1), servers: [] },
  "activity--old-agent": {
    tunnels: [],
    servers: serversIn("running", undefined, {
      host: { kind: "agent", agentId: "agent-lab" },
    }).slice(0, 1),
  },
};
const ACTIVITY_STATES = Object.keys(ACTIVITY_ROWS) as State[];

/** At 14:20 today, plus `seconds`. */
const at = (seconds: number) => new Date(2026, 10, 26, 14, 20, seconds).getTime();
const event = (seconds: number, status: string, reason?: string) => ({
  atMs: at(seconds),
  status,
  ...(reason ? { reason } : {}),
});
const RAN = [event(0, "connecting"), event(2, "connected")];
const DROPS = [
  ...RAN,
  event(40, "reconnecting", "Connection lost. Try 1 of 10 at 14:20:41."),
  event(41, "reconnecting", "Connection lost. Try 2 of 10 at 14:20:43."),
  event(43, "reconnecting", WHY.reconnecting),
];
/** What happened before each state, as the backend keeps it. */
const EVENTS: Partial<Record<State, unknown[]>> = {
  "activity--tunnel": RAN,
  "activity--tunnel-reconnecting": DROPS,
  "activity--tunnel-error": [event(0, "connecting"), event(15, "error", WHY.ssh)],
  "activity--tunnel-stopped": [...RAN, event(50, "disconnected")],
  "activity--server": [event(0, "starting"), event(1, "running")],
  "activity--server-nobody": [event(0, "starting"), event(1, "running")],
  "activity--server-unavailable": [event(0, "starting"), event(1, "running")],
  // The ring keeps 200: a tunnel on a flaky line.
  "activity--log-full": Array.from({ length: 200 }, (_, i) =>
    event(i, i % 2 ? "connected" : "reconnecting", i % 2 ? undefined : WHY.reconnecting)
  ),
  "activity--old-agent": [event(0, "starting"), event(1, "running")],
};

const EDITOR_STATES = (Object.keys(STATES) as State[]).filter((state) =>
  state.startsWith("server-editor--")
);
const TUNNEL_EDITOR_STATES = (Object.keys(STATES) as State[]).filter((state) =>
  state.startsWith("tunnel-editor--")
);

/** What else the backend answers in a state. */
const ANSWERS: Partial<Record<State, Partial<VisualScenario>>> = {
  "servers--open-unknown": { networkInterfaces: [] },
  "activity--server": { serverActivity: REQUESTS },
  "activity--server-nobody": { serverActivity: NO_REQUESTS },
  "activity--old-agent": { oldAgent: true },
};

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
}

interface GalleryState {
  sidebarView: string;
  setSidebarView(view: string): void;
  setSidebarWidth(width: number): void;
}

async function boot(page: Page, theme: string, state: State): Promise<void> {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(
    (scenario) => {
      window.__VISUAL_SCENARIO__ = scenario;
    },
    {
      populated: true,
      serviceData: data(
        ACTIVITY_ROWS[state]?.tunnels ??
          BOTH_ROWS[state]?.tunnels ??
          TUNNEL_ROWS[state] ??
          (state.startsWith("tunnel-editor--") ? tunnelsIn("connected") : []),
        ACTIVITY_ROWS[state]?.servers ??
          BOTH_ROWS[state]?.servers ??
          SERVER_ROWS[state] ??
          (state.startsWith("server-editor--") ? serversIn("running") : [])
      ),
      serviceEvents: { db: EVENTS[state] ?? [], web: EVENTS[state] ?? [] },
      ...ANSWERS[state],
    } satisfies VisualScenario
  );
  await page.goto("/tests/visual/harness/index.html");
  await page.waitForFunction(() => window.__visual !== undefined);
  await page.locator(id("sidebar")).waitFor();
  await page.evaluate((t) => {
    const store = window.__visual.store.getState() as unknown as GalleryState;
    if (store.sidebarView !== "services") store.setSidebarView("services");
    window.__visual.applyTheme(t);
  }, theme);
  await page.locator(id("services-sidebar")).waitFor();
  await settle(page);
}

/** What is wrong with a row: cut text, a missing state word, a wrong address. */
function rowProblems(): string[] {
  const problems: string[] = [];
  for (const row of Array.from(document.querySelectorAll<HTMLElement>(".service-row"))) {
    const name = row.querySelector(".sidebar-list-item__name")?.textContent ?? "?";
    const box = row.getBoundingClientRect();
    for (const part of [
      ".sidebar-list-item__name",
      ".service-row__kind",
      ".service-row__address",
      ".service-row__reason",
      ".service-row__machine",
      ".service-row__risk",
      ".service-row__reach",
      ".service-row__address button",
      ".sidebar-list-item__primary",
    ]) {
      for (const el of Array.from(row.querySelectorAll<HTMLElement>(part))) {
        const own = el.getBoundingClientRect();
        if (own.right > box.right + 1 || own.left < box.left - 1 || own.bottom > box.bottom + 1)
          problems.push(`${name}: ${part} leaves the row`);
        if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1)
          problems.push(`${name}: ${part} is cut`);
      }
    }
    const word = row.querySelector(".service-row__state")?.textContent ?? "";
    const dot = row.querySelector(".status-dot");
    if (!word || dot?.getAttribute("aria-label") !== word)
      problems.push(`${name}: the dot reads ${dot?.getAttribute("aria-label")}, the row ${word}`);
    const address = row.querySelector(".service-row__address");
    if ((word === "Running") !== (address !== null))
      problems.push(`${name}: ${word} ${address ? "with" : "without"} an address`);
    if (address?.textContent?.includes("0.0.0.0")) problems.push(`${name}: shows 0.0.0.0`);
    if (row.scrollWidth > row.clientWidth + 1) problems.push(`${name}: scrolls sideways`);
  }
  return problems;
}

test.beforeAll(() => {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(
    join(DIR, "index.json"),
    `${JSON.stringify(
      Object.entries(STATES).map(([name, situation]) => ({
        name,
        situation,
        screenshots: WINDOWS.flatMap((w) =>
          THEMES.map((theme) => `${name}--${w.width}x${w.height}--${theme}.png`)
        ),
      })),
      null,
      2
    )}\n`
  );
});

for (const viewport of WINDOWS) {
  const size = `${viewport.width}x${viewport.height}`;
  for (const theme of THEMES) {
    test.describe(`services at ${size}, ${theme}`, () => {
      test.use({ viewport });

      /** Shoot and check; `pointed`: the pointer reveals buttons over the name. */
      async function shot(page: Page, state: State, root: string, pointed = false): Promise<void> {
        await settle(page);
        const path = join(DIR, `${state}--${size}--${theme}.png`);
        await page.screenshot({ path });
        if (pointed) return;
        const issues = await page.evaluate(auditLayout, { root, styledClasses: STYLED_CLASSES });
        expect.soft(issues, state).toEqual([]);
        expect.soft(await page.evaluate(rowProblems), state).toEqual([]);
      }

      const rows = { ...TUNNEL_ROWS, ...SERVER_ROWS };
      for (const state of Object.keys(rows) as State[]) {
        const kind = state.startsWith("tunnels") ? "tunnel" : "server";
        test(state, async ({ page }) => {
          await boot(page, theme, state);
          await expect(page.locator(".service-row")).toHaveCount(rows[state]!.length);
          const first = rows[state]![0].id;
          if (state.endsWith("--narrow")) {
            const min = Number(
              await page.locator(id("sidebar-resize-handle")).getAttribute("aria-valuemin")
            );
            await page.evaluate((width) => {
              (window.__visual.store.getState() as unknown as GalleryState).setSidebarWidth(width);
            }, min);
          } else if (state.endsWith("--hover")) {
            await page.locator(id(`${kind}-kind-${first}`)).hover();
          } else if (state.endsWith("--menu")) {
            await page.locator(id(`${kind}-kind-${first}`)).hover();
            await page.locator(id(`${kind}-more-${first}`)).click();
            await page.locator("[role=menu]").waitFor();
          }
          if (state.endsWith("--tooltip")) {
            await page.locator(id(`${kind}-name-${first}`)).hover();
            await page
              .locator(id(`${kind}-tooltip-${first}`))
              .first()
              .waitFor();
          } else if (state.endsWith("--stop")) {
            await page.locator(id(`${kind}-stop-${first}`)).click();
            await page.locator("[role=alertdialog], [role=dialog]").waitFor();
          } else if (state.endsWith("--delete")) {
            await page.locator(id(`${kind}-item-${first}`)).focus();
            await page.keyboard.press("Delete");
            await page.locator("[role=alertdialog], [role=dialog]").waitFor();
          } else if (state.endsWith("--edit")) {
            await page.locator(id(`tunnel-item-${first}`)).focus();
            await page.keyboard.press("Enter");
            await page.locator(id("tunnel-editor")).waitFor();
          }
          if (state.endsWith("--mixed-error")) {
            await page.locator(id("service-count-error")).click();
            await expect(page.locator(".service-row")).toHaveCount(1);
          }
          const over = /--(hover|menu|tooltip|stop|delete)$/.test(state);
          await shot(page, state, id("services-sidebar"), over);
        });
      }

      for (const state of ACTIVITY_STATES) {
        test(state, async ({ page }) => {
          await boot(page, theme, state);
          const tunnel = ACTIVITY_ROWS[state]!.tunnels.length > 0;
          const first = (tunnel ? ACTIVITY_ROWS[state]!.tunnels : ACTIVITY_ROWS[state]!.servers)[0];
          const kind = tunnel ? "tunnel" : "server";
          await page.locator(id(`${kind}-kind-${first.id}`)).hover();
          await page
            .locator(
              id(tunnel ? `tunnel-activity-${first.id}` : `server-open-activity-${first.id}`)
            )
            .click();
          await page.locator(id("service-activity")).waitFor();
          if (!tunnel) await page.locator(id(`server-activity-${first.id}`)).waitFor();
          await page.mouse.move(viewport.width - 20, viewport.height / 2);
          await page.evaluate(() => (document.activeElement as HTMLElement).blur());
          await shot(page, state, id(tunnel ? "tunnel-editor" : "server-editor"));
        });
      }

      for (const state of TUNNEL_EDITOR_STATES) {
        test(state, async ({ page }) => {
          await boot(page, theme, state);
          const field = (name: string) => page.locator(id(`tunnel-editor-${name}`));
          const open = async (kind: string) => {
            await page.locator(id("service-new-btn")).click();
            await page.locator(id(`service-new-tunnel-${kind}`)).click();
            await page.locator(id("tunnel-editor")).waitFor();
          };
          const onAgent = async () => {
            await field("host").click();
            await page.locator("[role=option]").nth(1).click();
          };
          switch (state) {
            case "tunnel-editor--local":
              await open("local");
              await field("remote-host").fill("db.internal");
              await field("remote-port").fill("5432");
              break;
            case "tunnel-editor--remote":
            case "tunnel-editor--dynamic":
              await open(state.slice("tunnel-editor--".length));
              break;
            case "tunnel-editor--open":
              await open("local");
              await field("bind-network").click();
              break;
            case "tunnel-editor--open-remote":
              await open("remote");
              await field("bind-network").click();
              break;
            case "tunnel-editor--missing":
              await open("local");
              await field("remote-host").fill("");
              await field("save-start").click({ force: true });
              break;
            case "tunnel-editor--agent":
              await open("local");
              await onAgent();
              await field("reachability").scrollIntoViewIfNeeded();
              break;
            case "tunnel-editor--kinds":
              await open("local");
              await page.locator(id("tunnel-editor-change-type")).click();
              break;
            case "tunnel-editor--path":
              await open("local");
              await field("show-path").click();
              await field("endpoints").scrollIntoViewIfNeeded();
              break;
            case "tunnel-editor--edit":
              await page.locator(id("tunnel-item-db")).focus();
              await page.keyboard.press("Enter");
              await page.locator(id("tunnel-editor")).waitFor();
              break;
          }
          await shot(page, state, id("tunnel-editor"));
        });
      }

      for (const state of EDITOR_STATES) {
        test(state, async ({ page }) => {
          await boot(page, theme, state);
          const field = (name: string) => page.locator(id(`server-dialog-${name}`));
          const open = async (kind: string) => {
            await page.locator(id("service-new-btn")).click();
            await page.locator(id(`service-new-server-${kind}`)).click();
            await page.locator(id("server-editor")).waitFor();
          };
          /** Where the reviewer should look, as the user scrolled there. */
          const look = (name: string) => field(name).scrollIntoViewIfNeeded();
          switch (state) {
            case "server-editor--http":
            case "server-editor--ftp":
            case "server-editor--tftp":
              await open(state.slice("server-editor--".length));
              break;
            case "server-editor--port-taken":
              await open("http");
              await field("port").fill("8080");
              break;
            case "server-editor--share":
              await page.evaluate(() => {
                const store = window.__visual.store.getState() as unknown as {
                  openServerEditorTab(id: null, options: object): void;
                };
                store.openServerEditorTab(null, { serverType: "http", folder: "/home/ann/Builds" });
              });
              await page.locator(id("server-editor")).waitFor();
              break;
            case "server-editor--missing":
              await open("tftp");
              await field("save-start").click({ force: true });
              break;
            case "server-editor--warning":
              await open("ftp");
              await field("root").fill("/srv/inbox");
              await field("bind-network").click();
              await field("can-upload").click();
              await look("warning");
              break;
            case "server-editor--sign-in":
              await open("http");
              await field("root").fill("/srv/docs");
              await field("bind-network").click();
              await field("signin").click();
              await field("username").fill("team");
              await look("password");
              break;
            case "server-editor--address":
              await open("http");
              await field("root").fill("/srv/docs");
              await field("bind-address").click();
              await look("address");
              break;
            case "server-editor--agent":
              await open("http");
              await field("runloc").click();
              await page.locator("[role=option]").nth(1).click();
              await field("root").fill("/srv/docs");
              await field("bind-address").click();
              await field("address").fill("10.0.0.5");
              break;
            case "server-editor--kinds":
              await open("http");
              await page.locator(id("server-editor-change-type")).click();
              break;
            case "server-editor--edit":
            case "server-editor--unsaved":
              await page.locator(id("server-item-web")).focus();
              await page.keyboard.press("Enter");
              await page.locator(id("server-editor")).waitFor();
              if (state === "server-editor--unsaved") {
                await field("name").fill("Release builds 2");
                await field("cancel").click();
                await page.locator("[role=alertdialog], [role=dialog]").waitFor();
              }
              break;
          }
          await shot(
            page,
            state,
            state === "server-editor--unsaved" ? "[role=dialog]" : id("server-editor"),
            state === "server-editor--unsaved"
          );
        });
      }

      for (const state of Object.keys(BOTH_ROWS) as State[]) {
        test(state, async ({ page }) => {
          await boot(page, theme, state);
          const sidebar = id("services-sidebar");
          let over = false;
          switch (state) {
            case "services--closed":
              await page.locator(id("service-group-tunnels")).click();
              await expect(page.locator("[data-testid^=tunnel-item-]")).toHaveCount(0);
              break;
            case "services--new-menu":
              await page.locator(id("service-new-btn")).click();
              await page.locator("[role=menu]").waitFor();
              over = true;
              break;
            case "services--new-tunnel":
              await page.locator(id("service-new-btn")).click();
              await page.locator(id("service-new-tunnel-remote")).click();
              await expect(page.locator(id("tunnel-editor-title"))).toContainText("Let a server");
              break;
            case "services--search":
              await page.locator(id("services-search")).fill("15003");
              await expect(page.locator(".service-row")).toHaveCount(1);
              break;
            case "services--search-word":
              await page.locator(id("services-search")).fill("file server");
              await expect(page.locator("[data-testid^=tunnel-item-]")).toHaveCount(0);
              break;
            case "services--only-errors":
              await page.locator(id("service-count-error")).click();
              await page.locator(id("services-show-all")).waitFor();
              await page.mouse.move(viewport.width - 20, viewport.height / 2);
              break;
            case "services--stop-all":
              // In the toolbar's "…" while the sidebar is narrow.
              if (!(await page.locator(id("services-stop-all")).isVisible())) {
                await page.locator(id("services-more")).click();
              }
              await page.locator(id("services-stop-all")).click();
              await page.locator(id("confirm-service-lifecycle-dialog")).waitFor();
              over = true;
              break;
            case "services--open-connections":
              if (!(await page.locator(id("services-open-connections")).isVisible())) {
                await page.locator(id("services-more")).click();
              }
              await page.locator(id("services-open-connections")).click();
              await page.locator(id("open-connections-services-section")).waitFor();
              over = true;
              break;
            case "services--quit":
              await page.evaluate(() => {
                const store = window.__visual.store.getState() as unknown as {
                  prepareAppQuit(owns: boolean): string;
                };
                store.prepareAppQuit(true);
              });
              await page.locator(id("close-window-decision-dialog")).waitFor();
              over = true;
              break;
            case "services--nothing":
              await page.locator(id("services-search")).fill("jenkisn");
              await page.locator(id("services-none")).waitFor();
              break;
            case "services--palette":
              await page.evaluate(() => {
                const store = window.__visual.store.getState() as unknown as {
                  setCommandPaletteOpen(open: boolean): void;
                };
                store.setCommandPaletteOpen(true);
              });
              await page.locator("[role=combobox]").fill("tunnel");
              await page.getByText("Show services").waitFor();
              over = true;
              break;
            case "services--narrow": {
              const min = Number(
                await page.locator(id("sidebar-resize-handle")).getAttribute("aria-valuemin")
              );
              await page.evaluate((width) => {
                const store = window.__visual.store.getState() as unknown as GalleryState;
                store.setSidebarWidth(width);
              }, min);
              break;
            }
          }
          await shot(page, state, sidebar, over);
        });
      }

      test("services--empty", async ({ page }) => {
        await boot(page, theme, "services--empty");
        await page.locator(id("services-empty")).waitFor();
        await shot(page, "services--empty", id("services-sidebar"));
      });
    });
  }
}
