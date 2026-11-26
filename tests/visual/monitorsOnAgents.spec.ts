/**
 * HTTP monitors on agents (#6039, #6052): the sidebar rows and the panel's list
 * say where each checks from and, on an agent, what is known there: running,
 * not reachable, stopping, or not started with why. 800x600 and 1280x800, dark
 * and light. Screenshots and `index.json` land in screens/monitors/ for review.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import type { VisualHandle } from "./harness/visualHandle";
import type { VisualScenario } from "./harness/mockBackend";
import { auditLayout } from "./layoutAudit";
import { SCREENS } from "./surfaces";
import { styledPrimitiveClasses } from "./uiClasses";

declare global {
  interface Window {
    __visual: VisualHandle;
    __VISUAL_SCENARIO__?: VisualScenario;
  }
}

const STYLED_CLASSES = styledPrimitiveClasses();
const DIR = join(SCREENS, "monitors");
const WINDOWS = [
  { width: 800, height: 600 },
  { width: 1280, height: 800 },
];
const THEMES = ["dark", "light"];
const id = (testId: string) => `[data-testid="${testId}"]`;

const STATES = {
  sidebar: "Which monitors check, from where, and which do not right now?",
  panel: "The monitor panel: where each runs and why one does not check.",
} as const;
type State = keyof typeof STATES;

const LAB = { kind: "agent", agentId: "agent-lab" };
const EDGE = { kind: "agent", agentId: "agent-edge" };
const AT = Date.parse("2026-11-26T14:20:00Z");

const config = (monitorId: string, url: string, host?: object) => ({
  id: monitorId,
  url,
  intervalMs: 30000,
  method: "GET",
  expectedStatus: 200,
  timeoutMs: 5000,
  ...(host ? { host } : {}),
});
const ok = (monitorId: string) => ({
  monitorId,
  statusCode: 200,
  latencyMs: 42,
  ok: true,
  timestampMs: AT,
});

/** One of each: here, on an agent, its agent gone, a stop owed, not started. */
const MONITORS = [
  {
    config: config("here", "https://api.example.com/health"),
    running: true,
    paused: false,
    lastResult: ok("here"),
    status: "running",
  },
  {
    config: config("lab", "https://intranet.lab/status", LAB),
    running: true,
    paused: false,
    lastResult: ok("lab"),
    status: "running",
  },
  {
    config: config("edge", "https://router.edge/ping", EDGE),
    running: false,
    paused: false,
    status: "notReachable",
    reason: "Its agent is offline. It may still run there; termiHub cannot tell.",
  },
  {
    config: config("owed", "https://printer.edge/", EDGE),
    running: false,
    paused: false,
    status: "stopping",
    reason: "Its agent is offline. It will be stopped when the agent is back.",
  },
  {
    config: config("cloud", "https://status.cloud/", { kind: "cloud", region: "eu" }),
    running: false,
    paused: false,
    status: "error",
    reason: "Not started: termiHub cannot read where it runs.",
  },
];

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
}

async function boot(page: Page, theme: string): Promise<void> {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript((monitors) => {
    window.__VISUAL_SCENARIO__ = {
      populated: true,
      answers: { network_http_monitor_list: monitors },
    };
  }, MONITORS as unknown[]);
  await page.goto("/tests/visual/harness/index.html");
  await page.waitForFunction(() => window.__visual !== undefined);
  await page.locator(id("sidebar")).waitFor();
  await page.evaluate((t) => {
    const store = window.__visual.store.getState() as unknown as {
      sidebarView: string;
      setSidebarView(view: string): void;
    };
    if (store.sidebarView !== "network-tools") store.setSidebarView("network-tools");
    window.__visual.applyTheme(t);
  }, theme);
  await page.locator(id("monitor-row-edge")).waitFor();
  await settle(page);
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
    test.describe(`monitors at ${size}, ${theme}`, () => {
      test.use({ viewport });

      async function shot(page: Page, state: State, root: string): Promise<void> {
        await settle(page);
        await page.screenshot({ path: join(DIR, `${state}--${size}--${theme}.png`) });
        const issues = await page.evaluate(auditLayout, { root, styledClasses: STYLED_CLASSES });
        expect.soft(issues, state).toEqual([]);
      }

      test("sidebar", async ({ page }) => {
        await boot(page, theme);
        await expect(page.locator(id("monitor-status-edge"))).toHaveAttribute(
          "aria-label",
          "Not reachable"
        );
        await expect(page.locator(id("monitor-row-owed"))).toContainText("will be stopped");
        await shot(page, "sidebar", id("sidebar"));
      });

      test("panel", async ({ page }) => {
        await boot(page, theme);
        await page.evaluate(() => {
          const store = window.__visual.store.getState() as unknown as {
            openNetworkDiagnosticTab(tool: string): void;
          };
          store.openNetworkDiagnosticTab("http-monitor");
        });
        const lab = page.locator(`.http-monitor-row${id("monitor-row-lab")}`);
        await lab.scrollIntoViewIfNeeded();
        await expect(lab).toContainText("on Raspberry Pi in the lab");
        await expect(page.locator(id("monitor-reason-edge"))).toContainText("offline");
        await page.locator(id("monitor-reason-cloud")).scrollIntoViewIfNeeded();
        await shot(page, "panel", ".network-panel");
      });
    });
  }
}
