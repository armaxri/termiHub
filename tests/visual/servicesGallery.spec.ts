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
  "tunnels--stopped": "Find the tunnel you need and start it.",
  "tunnels--waiting": "Two tunnels have not started yet: why, and will they?",
  "tunnels--starting": "A tunnel was just started: is it there yet?",
  "tunnels--running": "The tunnel runs: what do you type to use it?",
  "tunnels--reconnecting": "The connection dropped: what happens now?",
  "tunnels--stopping": "Stop was pressed while the agent is away: is it stopped?",
  "tunnels--error": "A tunnel did not start: why, and what now?",
  "tunnels--needs-connection": "A connection was deleted: what about its tunnel?",
  "tunnels--not-reachable": "The agent is gone: does the tunnel still run?",
  "tunnels--on-agent": "Tunnels on other machines: where can you use each?",
  "tunnels--chained": "A hop to this computer: does localhost work, and if not, what now?",
  "tunnels--narrow": "The narrowest sidebar, long names: read everything.",
  "tunnels--hover": "Change, copy or delete a running tunnel.",
  "tunnels--menu": "The same, from its menu.",
  "servers--stopped": "Find the folder you share and start it.",
  "servers--waiting": "Two servers have not started yet: why, and will they?",
  "servers--starting": "A server was just started: is it there yet?",
  "servers--running": "The server runs: what do you tell the other person?",
  "servers--stopping": "Stop was pressed while the agent is away: is it stopped?",
  "servers--error": "A server did not start: why, and what now?",
  "servers--not-reachable": "The agent is gone: does the server still run?",
  "servers--on-agent": "Servers on other machines: where can others open each?",
  "servers--narrow": "The narrowest sidebar, long names: read everything.",
  "servers--hover": "Open, change or delete a running server.",
  "servers--menu": "The same, from its menu.",
  "servers--activity": "Who uses the server right now?",
  "servers--new": "Make a new file server: which kind is right?",
} as const;
type State = keyof typeof STATES;

const EDGE = "Edge gateway in the Frankfurt datacenter rack";
const ON_EDGE = { kind: "agent", agentId: "agent-edge" };
const STATS = { bytesSent: 2048, bytesReceived: 8192, activeConnections: 1, totalConnections: 3 };

/** The sentences the backend writes (src-tauri/src/agent_service.rs). */
const WHY = {
  agent: `Waiting for agent ${EDGE}. Starts by itself when the agent is connected.`,
  store: "Waiting for the credential store. Starts by itself when you unlock it.",
  stopping: `Agent ${EDGE} is offline. Stops as soon as the agent is connected again.`,
  expired: `Not started: agent ${EDGE} was not connected within 30 minutes. Connect it, then start again.`,
  port: "Port 8080 is already in use on 127.0.0.1. Choose another port, or stop what uses it.",
  ssh: "SSH connect failed: Connection refused (os error 61)",
  away: `Agent ${EDGE} is offline. It may still run there; termiHub cannot tell.`,
  silent: `Agent ${EDGE} did not answer the start. It may run there; termiHub cannot tell.`,
  reconnecting: "connection lost: SSH session closed. Reconnecting (attempt 3/10) in 8s",
};

interface Row {
  id: string;
  name: string;
  type?: string;
  status: string;
  error?: string;
  over?: Record<string, unknown>;
  state?: Record<string, unknown>;
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
const tunnelsIn = (status: string, error?: string, over?: Record<string, unknown>): Row[] => [
  { id: "db", name: "Shop database", type: "local", status, error, over },
  { id: "web", name: "Show my web app", type: "remote", status, error, over },
  { id: "proxy", name: "Browse the office network", type: "dynamic", status, error, over },
];

/** The three kinds of file server in one status. */
const serversIn = (status: string, error?: string, over?: Record<string, unknown>): Row[] => [
  { id: "web", name: "Release builds", type: "http", status, error, over },
  { id: "scans", name: "Scanner inbox", type: "ftp", status, error, over },
  { id: "boot", name: "Switch firmware", type: "tftp", status, error, over },
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
const TUNNEL_ROWS: Partial<Record<State, Row[]>> = {
  "tunnels--stopped": tunnelsIn("disconnected"),
  "tunnels--waiting": [
    ...tunnelsIn("waiting", WHY.agent, { host: ON_EDGE }).slice(0, 1),
    { id: "bastion", name: "Behind a bastion", status: "waiting", error: WHY.store },
  ],
  "tunnels--starting": tunnelsIn("connecting"),
  "tunnels--running": tunnelsIn("connected"),
  "tunnels--reconnecting": tunnelsIn("reconnecting", WHY.reconnecting),
  "tunnels--stopping": tunnelsIn("stopping", WHY.stopping, { host: ON_EDGE }),
  "tunnels--error": [
    ...tunnelsIn("error", WHY.ssh).slice(0, 1),
    { id: "late", name: "Metrics", status: "error", error: WHY.expired, over: { host: ON_EDGE } },
  ],
  "tunnels--needs-connection": tunnelsIn("missingConnection"),
  "tunnels--not-reachable": [
    ...tunnelsIn("notReachable", WHY.away, { host: ON_EDGE }).slice(0, 2),
    {
      id: "un",
      name: "Grafana",
      status: "notReachable",
      error: WHY.silent,
      over: { host: ON_EDGE },
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
  ],
  "tunnels--chained": [
    { id: "parent", name: "Shop database", status: "connected", over: { host: ON_EDGE } },
    {
      id: "hop",
      name: "Shop database (hop on this computer)",
      status: "error",
      error: WHY.port,
      over: { companionOf: "parent" },
    },
  ],
  "tunnels--narrow": [
    {
      id: "l1",
      name: LONG,
      status: "connected",
      over: { host: ON_EDGE, description: "Read only" },
    },
    { id: "l2", name: LONG, status: "notReachable", error: WHY.away, over: { host: ON_EDGE } },
    { id: "l3", name: "Proxy", type: "dynamic", status: "connected" },
  ],
  "tunnels--hover": tunnelsIn("connected"),
  "tunnels--menu": tunnelsIn("connected"),
};
const SERVER_ROWS: Partial<Record<State, Row[]>> = {
  "servers--stopped": serversIn("stopped"),
  "servers--waiting": [
    ...serversIn("waiting", WHY.agent, { host: ON_EDGE }).slice(0, 1),
    { id: "pw", name: "With a password", status: "waiting", error: WHY.store },
  ],
  "servers--starting": serversIn("starting"),
  "servers--running": [
    ...serversIn("running"),
    { id: "wide", name: "For the team", status: "running", over: { bindHost: "0.0.0.0" } },
  ],
  "servers--stopping": serversIn("stopping", WHY.stopping, { host: ON_EDGE }),
  "servers--error": serversIn("error", WHY.port),
  "servers--not-reachable": [
    ...serversIn("notReachable", WHY.away, { host: ON_EDGE }).slice(0, 2),
    { id: "un", name: "Docs", status: "notReachable", error: WHY.silent, over: { host: ON_EDGE } },
  ],
  "servers--on-agent": [
    { id: "there", name: "Only on the gateway", status: "running", over: { host: ON_EDGE } },
    {
      id: "lan",
      name: "For its network",
      status: "running",
      over: { host: ON_EDGE, bindHost: "0.0.0.0" },
    },
  ],
  "servers--narrow": [
    { id: "l1", name: LONG, status: "running", over: { host: ON_EDGE, description: "Read only" } },
    { id: "l2", name: LONG, status: "notReachable", error: WHY.away, over: { host: ON_EDGE } },
    { id: "l3", name: "Boot", type: "tftp", status: "running", over: { bindHost: "0.0.0.0" } },
  ],
  "servers--hover": serversIn("running"),
  "servers--menu": serversIn("running"),
  "servers--activity": serversIn("running").slice(0, 1),
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
  const view = state.startsWith("tunnels") ? "tunnels" : "services";
  await page.addInitScript(
    (scenario) => {
      window.__VISUAL_SCENARIO__ = scenario;
    },
    {
      populated: true,
      serviceData: data(TUNNEL_ROWS[state] ?? [], SERVER_ROWS[state] ?? []),
    } satisfies VisualScenario
  );
  await page.goto("/tests/visual/harness/index.html");
  await page.waitForFunction(() => window.__visual !== undefined);
  await page.locator(id("sidebar")).waitFor();
  await page.evaluate(
    ([t, v]) => {
      const store = window.__visual.store.getState() as unknown as GalleryState;
      if (store.sidebarView !== v) store.setSidebarView(v);
      window.__visual.applyTheme(t);
    },
    [theme, view]
  );
  await page.locator(id(`${view === "tunnels" ? "tunnel" : "server"}-sidebar`)).waitFor();
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
          await expect(page.locator("[role=treeitem]")).toHaveCount(rows[state]!.length);
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
          } else if (state.endsWith("--activity")) {
            await page.locator(id(`${kind}-kind-${first}`)).hover();
            await page.locator(id(`server-activity-toggle-${first}`)).click();
            await page.locator(id(`server-activity-${first}`)).waitFor();
            await page.mouse.move(viewport.width - 20, viewport.height / 2);
            await page.evaluate(() => (document.activeElement as HTMLElement).blur());
          }
          await shot(page, state, id(`${kind}-sidebar`), /--(hover|menu)$/.test(state));
        });
      }

      test("servers--new", async ({ page }) => {
        await boot(page, theme, "servers--new");
        await page.locator(id("server-new-btn")).click();
        await page.locator(id("server-dialog-name")).waitFor();
        await shot(page, "servers--new", "[role=dialog]");
      });
    });
  }
}
