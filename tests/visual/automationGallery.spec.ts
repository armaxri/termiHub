/**
 * One named screenshot per Automations surface and state (#5818, slice 12), at the
 * minimum window and the usual one, in dark and light, for a usability review by
 * someone who did not build them.
 *
 * Run `pnpm exec playwright test -c tests/visual/playwright.config.ts automationGallery`.
 * The shots land in `test-results/screens/automations/`, named
 * `<surface>--<state>--<window>--<theme>.png`, with `index.json` beside them: what the
 * user wants to do in each, so a reviewer grades a situation and not a picture.
 * Every shot is also audited for layout, so a broken state fails here.
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
const DIR = join(SCREENS, "automations");
const WINDOWS = [
  { width: 800, height: 600 },
  { width: 1280, height: 800 },
];
const THEMES = ["dark", "light"];
const id = (testId: string) => `[data-testid="${testId}"]`;
const STAMP = "2026-10-01T12:00:00Z";

/** Every state, and what the user wants to do there. */
const STATES = {
  "sidebar--empty": "First visit: understand what an automation is and make one.",
  "sidebar--filled": "Find an automation among several and see which ones start by themselves.",
  "sidebar--running": "See that something is running, where, and stop it.",
  "sidebar--switched-off": "See that a trigger and a hotkey are off, and turn one on.",
  "sidebar--search-empty": "A search finds nothing: get back to the list.",
  "editor--new-steps": "Make an automation step by step.",
  "editor--new-keys": "Make one that only types keys; nothing else should be in the way.",
  "editor--full": "Read a long automation: steps, triggers, values, tags.",
  "editor--triggers": "See and change what starts this automation.",
  "editor--add-step": "Choose the next step.",
  "editor--invalid": "Save was refused: see why and where.",
  "editor--local-process-off": "A step runs a program, but experimental features are off.",
  "editor--unknown-step": "A step of a newer version: see that it cannot run here.",
  "recording--chip": "Know that typing is being recorded, and stop it.",
  "recording--password-prompt": "Typing a password while recording: know that it is noticed.",
  "recording--save": "Name the recording, or add it to an automation.",
  "recording--save-password": "Decide what happens to the password that was typed.",
  "recording--unsaved": "The dialog was closed: the recording is still there.",
  "recording--record-steps": "Record the next step for the editor, and get back.",
  "run--target-picker": "Choose where to run.",
  "run--confirmation": "About to type into several terminals: check which.",
  "run--running": "The automation types into this terminal: see progress, stop it.",
  "run--failed": "A run was refused or failed: see why.",
  "run--history": "Find out what ran, when, where and how it ended.",
  "schedules--list": "See what runs by itself and when; turn one off.",
  "schedules--missed": "A scheduled run was missed and one failed: find out why.",
  "schedules--editor": "Run an automation every night on chosen connections.",
  "palette--automations": "Find an automation by name and see where it will run.",
  "import--notes": "After an import: what was switched off, left out, refused.",
} as const;
type State = keyof typeof STATES;

const automation = (over: Record<string, unknown>) => ({
  tags: [],
  steps: [{ kind: "send-command", command: "make" }],
  triggers: [],
  createdAt: STAMP,
  updatedAt: STAMP,
  ...over,
});

/** A library with every kind of row. */
const LIBRARY = [
  automation({
    id: "keys",
    name: "Deploy staging",
    description: "Pull, build and restart the web tier",
    steps: [
      {
        kind: "type-keys",
        chunks: [
          { data: "git pull", delayMs: 0 },
          { data: "\r", delayMs: 180 },
        ],
        timing: "recorded",
        recorded: true,
      },
    ],
  }),
  automation({
    id: "full",
    name: "Release",
    description: "Build, check and announce a release",
    tags: ["release", "ops"],
    steps: [
      {
        kind: "type-keys",
        chunks: [
          { data: "git fetch --all --prune", delayMs: 0 },
          { data: "\r", delayMs: 180 },
        ],
        timing: "fixed",
        fixedDelayMs: 25,
        recorded: true,
      },
      {
        kind: "send-command",
        command: "make -C /srv/release/current build test package ENV=${env}",
        retry: { count: 3, delayMs: 1000, backoff: "exponential" },
        continueOnError: true,
      },
      { kind: "wait-for-output", pattern: "Build (OK|DONE)", isRegex: true, timeoutMs: 60000 },
      {
        kind: "conditional",
        condition: { left: "${env}", op: "eq", right: "prod" },
        then: [{ kind: "wait", delayMs: 1200 }],
      },
      { kind: "run-local-process", program: "notify-send", args: ["released", "${env}"] },
    ],
    triggers: [
      { kind: "hotkey", binding: "Ctrl+Alt+R" },
      { kind: "on-output-match", connectionIds: ["conn-1"], pattern: "Continue?" },
    ],
    parameters: [{ name: "env", type: "enum", options: ["dev", "prod"], default: "dev" }],
  }),
  automation({
    id: "off-trigger",
    name: "Nightly cleanup",
    triggers: [{ kind: "on-connect", connectionIds: ["conn-1"] }],
    triggersEnabled: false,
  }),
  automation({
    id: "off-hotkey",
    name: "Restart the proxy",
    triggers: [{ kind: "hotkey", binding: "Ctrl+Alt+P" }],
    triggersEnabled: false,
  }),
  automation({
    id: "unknown",
    name: "From a newer version",
    steps: [
      { kind: "send-command", command: "uptime" },
      { kind: "take-snapshot", volume: "data" },
    ],
  }),
  automation({ id: "failed", name: "Nightly backup of the Frankfurt replica" }),
];

const run = (over: Record<string, unknown>) => ({
  automationName: "Release",
  automationId: "full",
  startedAt: STAMP,
  endedAt: STAMP,
  status: "completed",
  stepsCompleted: 5,
  total: 5,
  targetLabel: "prod-web",
  origin: "manual",
  ...over,
});
const RUNS = [
  run({
    id: "r1",
    automationId: "failed",
    automationName: "Nightly backup of the Frankfurt replica",
    status: "failed",
    stepsCompleted: 0,
    total: 1,
    failedStepIndex: 0,
    error: "The terminal stopped accepting input",
    targetLabel: "db-1",
    origin: "scheduled",
  }),
  run({ id: "r2", origin: "palette", endedAt: "2026-10-01T12:01:12Z" }),
  run({ id: "r3", status: "cancelled", stepsCompleted: 2, origin: "hotkey" }),
  run({ id: "r4", origin: "on-output-match", continuedFailures: 1 }),
  run({ id: "r5", automationId: "keys", automationName: "Deploy staging", total: 2 }),
];

const schedule = (over: Record<string, unknown>) => ({
  running: false,
  action: { kind: "automation", automationId: "failed" },
  targets: { kind: "connections", connectionIds: ["conn-1"] },
  rule: { kind: "daily", time: "02:00" },
  missedRuns: "skip",
  enabled: true,
  confirmedAt: STAMP,
  nextRunAt: "2026-10-02T02:00:00Z",
  createdAt: STAMP,
  updatedAt: STAMP,
  ...over,
});
const MISSED = {
  at: "2026-10-01T02:00:00Z",
  outcome: "skipped",
  message:
    "Missed the run due at 2026-10-01 02:00 (termiHub was closed or the computer was asleep)",
};
const FAILED = {
  at: "2026-09-30T02:00:00Z",
  startedAt: "2026-09-30T02:00:00Z",
  durationMs: 1200,
  outcome: "failed",
  message: "A target terminal disconnected during playback",
};
const SCHEDULES = {
  paused: false,
  schedules: [
    schedule({
      id: "s1",
      name: "Backup every night",
      lastRunAt: FAILED.at,
      lastResult: MISSED,
      history: [FAILED, MISSED],
    }),
    schedule({
      id: "s2",
      name: "Health check",
      action: { kind: "automation", automationId: "full" },
      rule: { kind: "interval", everyMinutes: 30 },
      enabled: false,
    }),
  ],
};

/** An import that needs every note. */
const IMPORT = JSON.stringify({
  version: 1,
  automations: [
    automation({ id: "a", name: "Hot", triggers: [{ kind: "hotkey", binding: "F9" }] }),
    automation({ id: "b", name: "Snapshot", steps: [{ kind: "take-snapshot" }] }),
    { ...automation({ id: "c", name: "Partly known" }), later: true },
  ],
});

/** The store actions and fields the states are set up with. */
interface GalleryState {
  sidebarView: string;
  setSidebarView(view: string): void;
  loadAutomations(): Promise<void>;
  loadAutomationRuns(): Promise<void>;
  loadSchedules(): Promise<void>;
  openScheduleEditor(target: { scheduleId: string }): void;
  openSettingsTab(target: { category: string }): void;
  setCommandPaletteOpen(open: boolean): void;
  recordInput(tabId: string, data: string, readPrompt?: () => string): void;
  recording: { tabId: string } | null;
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
}

/** Boot the app with the gallery's library, on the Automations sidebar. */
async function boot(page: Page, theme: string, scenario: VisualScenario = {}): Promise<void> {
  await page.addInitScript(
    (s) => {
      window.__VISUAL_SCENARIO__ = s;
    },
    {
      populated: true,
      automationData: { automations: LIBRARY, runs: RUNS, schedules: SCHEDULES },
      ...scenario,
    }
  );
  await page.goto("/tests/visual/harness/index.html");
  await page.waitForFunction(() => window.__visual !== undefined);
  await page.locator(id("sidebar")).waitFor();
  await page.evaluate(async (t) => {
    const state = window.__visual.store.getState() as unknown as GalleryState;
    if (state.sidebarView !== "automations") state.setSidebarView("automations");
    await Promise.all([state.loadAutomations(), state.loadAutomationRuns(), state.loadSchedules()]);
    window.__visual.applyTheme(t);
  }, theme);
  await page.locator(id("automation-sidebar")).waitFor();
}

/** Boot with `count` connected terminals. */
async function bootWithTerminals(page: Page, theme: string, count: number): Promise<void> {
  await boot(page, theme, { terminal: true });
  for (let i = 0; i < count; i += 1) {
    if ((await page.locator("[data-testid^='tab-close-']").count()) <= i) {
      await page.locator(id("terminal-view-new-terminal")).click();
    }
  }
  await page.locator(".xterm").last().waitFor();
}

/** Start recording from the toolbar and type `keys`, each after `prompt`. */
async function record(page: Page, keys: [string, string][]): Promise<void> {
  if ((await page.locator(id("terminal-view-active-recording")).count()) === 0) {
    await page.locator(id("automation-record-btn")).click();
    await page.locator(id("terminal-view-active-recording")).waitFor();
  }
  await page.evaluate((typed) => {
    for (const [data, prompt] of typed) {
      const state = window.__visual.store.getState() as unknown as GalleryState;
      state.recordInput(state.recording!.tabId, data, () => prompt);
    }
  }, keys);
}

async function edit(page: Page, automationId: string): Promise<void> {
  await page.locator(id(`automation-item-${automationId}`)).hover();
  await page.locator(id(`automation-edit-${automationId}`)).click();
  await page.locator(id("automation-editor-dialog")).waitFor();
}

async function newAutomation(page: Page, entry: "steps" | "keys"): Promise<void> {
  await page.locator(id("automation-new-btn")).click();
  await page.locator(id(`automation-new-${entry}`)).click();
  await page.locator(id("automation-editor-dialog")).waitFor();
}

/** Choose "Run on…" of a row. */
async function runOn(page: Page, automationId: string): Promise<void> {
  await page.locator(id(`automation-item-${automationId}`)).click({ button: "right" });
  await page.locator(id(`automation-menu-run-on-${automationId}`)).click();
  await page.locator(id("run-targets-dialog")).waitFor();
}

const EDITOR = id("automation-editor-dialog");
const SIDEBAR = id("automation-sidebar");
const SAVE = id("recording-save-dialog");

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
  for (const theme of THEMES) {
    const where = `${viewport.width}x${viewport.height}--${theme}`;

    test.describe(`automations gallery ${where}`, () => {
      test.use({ viewport });

      /** Screenshot a state and audit `root`'s layout. */
      async function shot(page: Page, state: State, root: string): Promise<void> {
        await page.mouse.move(viewport.width - 2, viewport.height / 2);
        await settle(page);
        const path = join(DIR, `${state}--${where}.png`);
        await page.screenshot({ path });
        await test.info().attach(state, { path, contentType: "image/png" });
        const issues = await page.evaluate(auditLayout, { root, styledClasses: STYLED_CLASSES });
        expect.soft(issues, state).toEqual([]);
        const box = (await page.locator(root).first().boundingBox())!;
        expect.soft(box.x, state).toBeGreaterThanOrEqual(0);
        expect.soft(box.x + box.width, state).toBeLessThanOrEqual(viewport.width);
      }

      test("sidebar", async ({ page }) => {
        await boot(page, theme);
        await expect(page.locator("[role=treeitem]")).toHaveCount(LIBRARY.length);
        await shot(page, "sidebar--filled", SIDEBAR);
        await page.locator(id("automation-item-off-trigger")).scrollIntoViewIfNeeded();
        await expect(page.locator(id("automation-armed-off-hotkey"))).toHaveText("Off");
        await shot(page, "sidebar--switched-off", SIDEBAR);
        await page.locator(id("automation-search")).fill("kubernetes");
        await page.locator(id("automation-no-results")).waitFor();
        await shot(page, "sidebar--search-empty", SIDEBAR);
      });

      test("sidebar, empty", async ({ page }) => {
        await boot(page, theme, {
          automationData: {
            automations: [],
            runs: [],
            schedules: { paused: false, schedules: [] },
          },
        });
        await page.locator(id("automation-empty")).waitFor();
        await shot(page, "sidebar--empty", SIDEBAR);
      });

      test("running", async ({ page }) => {
        await bootWithTerminals(page, theme, 1);
        // A playback that is under way, as the store shows it.
        await page.evaluate(() => {
          const store = window.__visual.store as unknown as {
            getState(): { recording: unknown; rootPanel: unknown };
            setState(partial: unknown): void;
          };
          const tab = document.querySelector("[data-testid^='tab-close-']")!;
          const tabId = tab.getAttribute("data-testid")!.replace("tab-close-", "");
          store.setState({
            macroPlayback: {
              macroId: "keys",
              macroName: "Deploy staging",
              tabId,
              total: 12,
              played: 5,
            },
          });
        });
        await page.locator(id("automation-running-keys")).waitFor();
        await shot(page, "sidebar--running", SIDEBAR);
        await page.locator(id("terminal-view-active-playback")).waitFor();
        await shot(page, "run--running", id("terminal-view-toolbar-actions"));
      });

      test("editor", async ({ page }) => {
        await boot(page, theme);
        await newAutomation(page, "keys");
        await shot(page, "editor--new-keys", EDITOR);
        await page.locator(id("automation-editor-cancel")).click();
        await newAutomation(page, "steps");
        await shot(page, "editor--new-steps", EDITOR);
        await page.locator(id("automation-editor-add-step")).click();
        await page.locator(id("automation-editor-add-step-loop")).waitFor();
        // A short dialog must not cut the menu off (it clips what it holds).
        const dialog = (await page.locator(EDITOR).boundingBox())!;
        await expect
          .poll(
            async () =>
              (await page.locator(id("automation-editor-add-step-type-keys")).boundingBox())!.y
          )
          .toBeGreaterThanOrEqual(dialog.y);
        await shot(page, "editor--add-step", EDITOR);
        await page.locator(id("automation-editor-add-step-send-command")).click();
        // Save is aria-disabled while something is missing; the click says what.
        // The closing menu may still hold the first click.
        await expect(async () => {
          await page.locator(id("automation-editor-save")).click({ force: true });
          await expect(page.getByText("Name is required.")).toBeVisible({ timeout: 1000 });
        }).toPass();
        await shot(page, "editor--invalid", EDITOR);
      });

      test("editor, stored", async ({ page }) => {
        await boot(page, theme);
        await edit(page, "full");
        await shot(page, "editor--full", EDITOR);
        // Open already: this automation has triggers.
        await page.locator(id("automation-editor-triggers")).scrollIntoViewIfNeeded();
        await shot(page, "editor--triggers", EDITOR);
        await page.locator(id("automation-editor-cancel")).click();
        await edit(page, "unknown");
        await page.locator(id("automation-editor-step-toggle-1")).click();
        await page.locator(id("automation-editor-step-blocked-1")).waitFor();
        await shot(page, "editor--unknown-step", EDITOR);
      });

      test("editor, a local process step with the switch off", async ({ page }) => {
        await boot(page, theme, { experimentalOff: true });
        await edit(page, "full");
        await page.locator(id("automation-editor-step-toggle-4")).click();
        await page.locator(id("automation-editor-step-4")).scrollIntoViewIfNeeded();
        await shot(page, "editor--local-process-off", EDITOR);
      });

      test("recording", async ({ page }) => {
        await bootWithTerminals(page, theme, 1);
        await record(page, [["sudo -v\r", "$ "]]);
        await shot(page, "recording--chip", id("terminal-view-active-recording"));
        await record(page, [["h", "[sudo] password for arne: "]]);
        await expect(page.locator(id("terminal-view-active-recording"))).toContainText("password");
        await shot(page, "recording--password-prompt", id("terminal-view-active-recording"));
        await record(page, [["\r", "[sudo] password for arne: "]]);
        await page.locator(id("terminal-view-active-recording")).click();
        await page.locator(id("recording-save-secrets")).waitFor();
        await shot(page, "recording--save-password", SAVE);
        await page.keyboard.press("Escape");
        await page.locator(id("recording-bar-unsaved")).waitFor();
        await shot(page, "recording--unsaved", id("recording-bar-unsaved"));
        await page.locator(id("recording-bar-discard")).click();
        await record(page, [["git pull\r", "$ "]]);
        await page.locator(id("terminal-view-active-recording")).click();
        await page.locator(SAVE).waitFor();
        await shot(page, "recording--save", SAVE);
      });

      test("recording into the editor", async ({ page }) => {
        await bootWithTerminals(page, theme, 1);
        await edit(page, "full");
        await page.locator(id("automation-editor-record")).click();
        await page.locator(id("recording-bar-editor")).waitFor();
        await record(page, [["systemctl restart web\r", "$ "]]);
        await shot(page, "recording--record-steps", id("recording-bar-editor"));
      });

      test("run", async ({ page }) => {
        await bootWithTerminals(page, theme, 2);
        await runOn(page, "keys");
        await shot(page, "run--target-picker", id("run-targets-dialog"));
        await page.locator(id("run-targets-target-all")).click();
        await page.locator(id("run-targets-run")).click();
        await page.locator(id("run-targets-confirm-step")).waitFor();
        await shot(page, "run--confirmation", id("run-targets-dialog"));
      });

      test("run, failed", async ({ page }) => {
        await bootWithTerminals(page, theme, 1);
        await page.locator(id("automation-start-unknown")).click();
        await expect(page.locator(id("toast-region"))).toContainText("From a newer version");
        await shot(page, "run--failed", SIDEBAR);
      });

      test("history", async ({ page }) => {
        await boot(page, theme);
        await page.locator(id("automation-history-toggle")).click();
        await page.locator(id("automation-run-toggle-r1")).click();
        await page.locator(id("automation-run-error-r1")).waitFor();
        await shot(page, "run--history", SIDEBAR);
      });

      test("schedules", async ({ page }) => {
        await boot(page, theme);
        await page.locator(id("schedules-section-toggle")).click();
        await page.locator(id("schedule-enable-s1")).waitFor();
        await shot(page, "schedules--list", SIDEBAR);
        await page.locator(id("schedule-attempts-toggle-s1")).click();
        await page.locator(id("schedule-attempts-s1")).waitFor();
        await page.locator(id("schedule-attempts-s1")).scrollIntoViewIfNeeded();
        await shot(page, "schedules--missed", SIDEBAR);
        await page.locator(id("schedule-edit-s1")).click();
        await page.locator(id("schedule-editor-dialog")).waitFor();
        await shot(page, "schedules--editor", id("schedule-editor-dialog"));
      });

      test("palette", async ({ page }) => {
        await bootWithTerminals(page, theme, 1);
        await page.evaluate(() =>
          (window.__visual.store.getState() as unknown as GalleryState).setCommandPaletteOpen(true)
        );
        await page.locator(id("command-palette-input")).fill("re");
        await page.locator(id("command-palette-item-automation:full")).waitFor();
        await shot(page, "palette--automations", id("command-palette"));
      });

      test("import", async ({ page }) => {
        await boot(page, theme, { openFile: { path: "/tmp/in.json", text: IMPORT } });
        await page.locator(id("automation-new-btn")).click();
        await page.locator(id("automation-files-btn")).click();
        await page.locator(id("import-migration-automations-import-btn")).click();
        await page.locator(id("automation-import-note-refused")).waitFor();
        await page.locator(id("automation-import-note-left-out")).waitFor();
        await shot(page, "import--notes", id("automation-import-dialog"));
      });
    });
  }
}
