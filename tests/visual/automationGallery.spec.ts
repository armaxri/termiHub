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

import { VISUAL_SESSION_ID } from "./harness/interactionIds";
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
/** The time it is in every picture, so "today" and "tomorrow" fit the data. */
const NOW = "2026-10-01T18:00:00Z";
/** A connection of the mock backend, by its id. */
const BUILD_BOX = "Work/Build Box";

/** Every state, and what the user wants to do there. */
const STATES = {
  "sidebar--empty": "First visit: understand what an automation is and make one.",
  "sidebar--filled": "Find an automation among several and see which ones start by themselves.",
  "sidebar--selected": "The selected automation: change it.",
  "sidebar--running": "Something runs in another tab: see where and which step, get there.",
  "sidebar--two-runs": "Two automations run in three terminals: tell them apart, stop one.",
  "sidebar--waiting": "One run waits for the user, another one goes on: which needs something?",
  "sidebar--switched-off": "Triggers were just switched off: what no longer happens?",
  "sidebar--search-empty": "A search finds nothing: get back to the list.",
  "editor--new-steps": "Make an automation step by step.",
  "editor--new-keys": "Make one that only types keys; nothing else should be in the way.",
  "editor--full": "Read a long automation: steps, triggers, values, tags.",
  "editor--triggers": "See and change what starts this automation.",
  "editor--add-step": "Choose the next step.",
  "editor--invalid": "Save was refused: see why and where.",
  "editor--local-process-off": "A step runs a program, but experimental features are off.",
  "editor--unknown-step": "A step of a newer version: see that it cannot run here.",
  "editor--blocked-collapsed": "Closed, can one tell which step keeps it from running?",
  "editor--settings-aside": "Open settings was chosen: the editor waits with its changes.",
  "editor--add-trigger": "Choose what starts it.",
  "editor--on-connect": "Make it run when a connection opens, below another trigger.",
  "editor--hotkey": "Press the keys of a hotkey that an app shortcut already uses.",
  "editor--hotkey-other": "Press the keys of a hotkey that another automation uses.",
  "editor--wait-step": "Change how long a step waits.",
  "editor--condition-step": "Run steps only for production.",
  "editor--loop-step": "Repeat steps.",
  "editor--wait-for-user-step": "A step at which the user types something, e.g. a password.",
  "editor--step-menu": "Add a step right below this one.",
  "editor--insert-step": "Add a step between two others, with the pointer.",
  "editor--more-keys": "Type a key that has no letter.",
  "recording--chip": "Know that typing is being recorded, and stop it.",
  "recording--password-prompt": "Typing a password while recording: know that it is noticed.",
  "recording--save": "Name the recording, or add it to an automation.",
  "recording--save-password": "Decide what happens to the password that was typed.",
  "recording--unsaved": "The dialog was closed: the recording is still there.",
  "recording--quit": "Quit while recording: do not lose what was typed.",
  "recording--record-steps": "Record the next step for the editor, and get back.",
  "run--target-picker": "Choose where to run.",
  "run--confirmation": "About to type into several terminals: check which.",
  "run--running": "The automation types into this terminal: see progress, stop it.",
  "run--program": "A step wants to start a program on this computer: allow it or not.",
  "run--program-refused": "The program was not allowed: what became of the run?",
  "run--stopped": "A run was stopped: how far did it get?",
  "run--replace": "Start one while another one runs: what happens to it?",
  "run--wait-ended": "Nobody continued a run that waited: what now?",
  "run--quit": "Quit while automations run: know what is stopped.",
  "run--password-wait": "The run waits for a password: type it, then go on.",
  "run--password-still-asked": "Continue was pressed too early: the terminal still asks.",
  "run--password-typed": "The password was typed: let the run go on.",
  "run--password-wait-elsewhere": "A run waits in a terminal that does not show.",
  "run--values": "The automation asks for a value before it runs.",
  "run--failed": "A run failed: see which step and why, and what to do.",
  "run--history": "Find out what ran, when, where and how it ended.",
  "editor--triggers-deleted": "The connection a trigger watched was deleted: see and fix it.",
  "schedules--list": "See what runs by itself and when; turn one off.",
  "schedules--missed": "A scheduled run was missed and one failed: find out why.",
  "schedules--history": "Look up last night in the History: what ran, what did not, why.",
  "schedules--deleted": "A schedule's connection was deleted: see that it cannot run.",
  "schedules--paused": "All schedules are paused: see it, and that nothing runs.",
  "schedules--new": "A new schedule, opened from an automation: what is still to choose.",
  "schedules--new-refused": "Save was refused: see what is missing.",
  "schedules--new-nightly": "Every night, also on a closed connection: check before saving.",
  "schedules--saved": "The schedule was saved: is it on?",
  "schedules--first-on": "Switch it on for the first time: check what it will do.",
  "schedules--first-on-connects": "The same for one that also connects.",
  "schedules--editor": "Change an automation that runs every night on chosen connections.",
  "schedules--editor-deleted": "Edit a schedule whose connection was deleted.",
  "schedules--editor-asks": "Schedule an automation that asks for a value: can it run alone?",
  "schedules--editor-password": "Schedule an automation that may meet a password prompt.",
  "schedules--editor-waits": "Schedule an automation that waits for the user.",
  "palette--automations": "Find an automation by name and know what Enter does.",
  "palette--triggers-off": "Run one whose triggers are off: does it still run?",
  "palette--no-terminal": "The same without a terminal.",
  "palette--cannot-run": "Find one that cannot run: why?",
  "import--entry": "Get to the import.",
  "import--shown": "The imported ones in the list: which one needs a look?",
  "import--export": "Give an automation to somebody else.",
  "import--notes": "After an import: what came in, was switched off, left out, refused.",
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
      { kind: "on-output-match", connectionIds: [BUILD_BOX], pattern: "Continue?" },
    ],
    parameters: [{ name: "env", type: "enum", options: ["dev", "prod"], default: "dev" }],
  }),
  automation({
    id: "off-trigger",
    name: "Nightly cleanup",
    triggers: [{ kind: "on-connect", connectionIds: [BUILD_BOX] }],
    triggersEnabled: false,
  }),
  automation({
    id: "off-hotkey",
    name: "Restart the proxy",
    triggers: [{ kind: "hotkey", binding: "Ctrl+Alt+P" }],
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
/** The nightly cleanup at 02:00 on a day: its run, and the schedule's attempt. */
const nightlyRun = (month: string, day: string) =>
  run({
    id: `n${month}-${day}`,
    automationId: "off-trigger",
    automationName: "Nightly cleanup",
    startedAt: `2026-${month}-${day}T02:00:00Z`,
    endedAt: `2026-${month}-${day}T02:00:04Z`,
    stepsCompleted: 1,
    total: 1,
    targetLabel: "Build Box",
    origin: "scheduled",
  });
const nightlyAttempt = (month: string, day: string) => ({
  at: `2026-${month}-${day}T02:00:04Z`,
  startedAt: `2026-${month}-${day}T02:00:00Z`,
  durationMs: 4000,
  outcome: "completed",
  message: "Ran on 1 terminal",
  runIds: [`n${month}-${day}`],
});
const RUNS = [
  run({ id: "r2", origin: "palette", endedAt: "2026-10-01T12:01:12Z" }),
  run({ id: "r3", status: "cancelled", stepsCompleted: 2, origin: "hotkey" }),
  nightlyRun("10", "01"),
  run({
    id: "r1",
    automationId: "failed",
    automationName: "Nightly backup of the Frankfurt replica",
    startedAt: "2026-10-01T01:00:00Z",
    endedAt: "2026-10-01T01:00:01Z",
    status: "failed",
    stepsCompleted: 0,
    total: 1,
    failedStepIndex: 0,
    error: "The terminal stopped accepting input",
    targetLabel: "Build Box",
    origin: "scheduled",
  }),
  run({
    id: "r4",
    origin: "on-output-match",
    continuedFailures: 1,
    endedAt: "2026-09-30T09:00:00Z",
  }),
  run({
    id: "r5",
    automationId: "keys",
    automationName: "Deploy staging",
    total: 2,
    endedAt: "2026-09-30T08:00:00Z",
  }),
  nightlyRun("09", "30"),
];

const schedule = (over: Record<string, unknown>) => ({
  running: false,
  action: { kind: "automation", automationId: "failed" },
  targets: { kind: "connections", connectionIds: [BUILD_BOX] },
  rule: { kind: "daily", time: "02:00" },
  missedRuns: "skip",
  enabled: true,
  confirmedAt: STAMP,
  nextRunAt: "2026-10-02T02:00:00Z",
  createdAt: STAMP,
  updatedAt: STAMP,
  ...over,
});
/** Missed today at 02:00, noticed when termiHub was opened at 07:45. */
const MISSED = {
  at: "2026-10-01T07:45:00Z",
  outcome: "skipped",
  missedDueAt: "2026-10-01T02:00:00Z",
  message: "termiHub was closed or the computer was asleep",
};
const CLEANED_TODAY = nightlyAttempt("10", "01");
const CLEANED_YESTERDAY = nightlyAttempt("09", "30");
/** Failed today at 01:00: the run `r1`. */
const FAILED = {
  at: "2026-10-01T01:00:01Z",
  startedAt: "2026-10-01T01:00:00Z",
  durationMs: 1200,
  outcome: "failed",
  message: "Build Box: The terminal stopped accepting input",
  runIds: ["r1"],
};
const NIGHTLY = schedule({
  id: "s1",
  name: "Clean up every night",
  action: { kind: "automation", automationId: "off-trigger" },
  connectIfNeeded: true,
  lastRunAt: CLEANED_TODAY.startedAt,
  lastResult: CLEANED_TODAY,
  history: [CLEANED_TODAY, CLEANED_YESTERDAY],
});
const HEALTH_CHECK = schedule({
  id: "s2",
  name: "Health check",
  action: { kind: "automation", automationId: "keys" },
  rule: { kind: "interval", everyMinutes: 30 },
  enabled: false,
  confirmedAt: undefined,
  nextRunAt: undefined,
});
const ARCHIVE = schedule({
  id: "s3",
  name: "Copy to the archive",
  rule: { kind: "daily", time: "01:00" },
  nextRunAt: "2026-10-02T01:00:00Z",
  lastRunAt: FAILED.startedAt,
  lastResult: FAILED,
  history: [FAILED],
});
const SCHEDULES = { paused: false, schedules: [NIGHTLY, HEALTH_CHECK, ARCHIVE] };
/** A night in which one was missed and one failed. */
const TROUBLED = {
  paused: false,
  schedules: [{ ...NIGHTLY, lastResult: MISSED, history: [MISSED, CLEANED_YESTERDAY] }, ARCHIVE],
};
/** The runs of that night: the missed one left none. */
const TROUBLED_RUNS = RUNS.filter((r) => (r as { id?: string }).id !== "n10-01");
const DELETED = {
  paused: false,
  schedules: [
    { ...NIGHTLY, targets: { kind: "connections", connectionIds: ["Work/Old Build Box"] } },
    HEALTH_CHECK,
  ],
};
/** Automations that cannot simply run alone. */
const UNATTENDED = [
  ...LIBRARY,
  automation({
    id: "asks",
    name: "Deploy a version",
    steps: [{ kind: "send-command", command: "deploy ${version}" }],
    parameters: [{ name: "version", type: "string", required: true }],
  }),
  automation({
    id: "sudo",
    name: "Restart the web server",
    steps: [{ kind: "send-command", command: "sudo systemctl restart nginx" }],
  }),
];

/** One of every step that is edited in place, and what meets a password. */
const BODIES = [
  ...LIBRARY,
  automation({
    id: "bodies",
    name: "Check the web tier",
    steps: [
      { kind: "wait", delayMs: 2500 },
      {
        kind: "conditional",
        condition: { left: "${env}", op: "eq", right: "prod" },
        then: [{ kind: "send-command", command: "systemctl status nginx" }],
        else: [{ kind: "send-command", command: "docker ps" }],
      },
      {
        kind: "loop",
        loop: { kind: "count", count: 3 },
        body: [{ kind: "send-command", command: "curl -sf localhost/health" }],
      },
      { kind: "wait-for-user", message: "Type your password" },
    ],
    triggers: [
      { kind: "hotkey", binding: "Ctrl+Alt+W" },
      { kind: "on-connect", connectionIds: [BUILD_BOX] },
    ],
    parameters: [{ name: "env", type: "enum", options: ["dev", "prod"], default: "dev" }],
  }),
  automation({
    id: "password",
    name: "Restart the web server",
    steps: [
      { kind: "send-command", command: "sudo systemctl restart nginx" },
      { kind: "wait-for-user", message: "Type your password" },
      { kind: "send-command", command: "systemctl status nginx" },
    ],
  }),
];

/** An import that needs every note. */
const IMPORT = JSON.stringify({
  version: 1,
  automations: [
    automation({ id: "a", name: "Hot", triggers: [{ kind: "hotkey", binding: "F9" }] }),
    automation({ id: "b", name: "Snapshot", steps: [{ kind: "take-snapshot" }] }),
    { ...automation({ id: "c", name: "Partly known" }), later: true },
  ],
});

/** Automations that keep running: a wait that does not end while the page is shot. */
const running = {
  automations: [
    automation({
      id: "health",
      name: "Health check",
      steps: [
        { kind: "send-command", command: "curl -sf localhost/health" },
        { kind: "wait", delayMs: 600_000 },
        { kind: "send-command", command: "systemctl status nginx" },
      ],
    }),
    automation({
      id: "typing",
      name: "Deploy staging",
      description: "Pull, build and restart the web tier",
      steps: [
        {
          kind: "type-keys",
          chunks: [
            { data: "git pull\r", delayMs: 0 },
            { data: "make deploy\r", delayMs: 600_000 },
          ],
          timing: "recorded",
          recorded: true,
        },
      ],
    }),
    ...BODIES.filter((a) => (a as { id?: string }).id === "password"),
    automation({
      id: "program",
      name: "Announce a release",
      steps: [{ kind: "run-local-process", program: "notify-send", args: ["released"] }],
    }),
    automation({
      id: "missing",
      name: "Deploy and check",
      steps: [
        { kind: "send-command", command: "make deploy" },
        { kind: "run-automation", automationId: "deleted" },
      ],
    }),
  ],
  runs: [],
  schedules: { paused: false, schedules: [] },
};

/** The store actions and fields the states are set up with. */
interface GalleryState {
  sidebarView: string;
  setSidebarView(view: string): void;
  loadAutomations(): Promise<void>;
  loadAutomationRuns(): Promise<void>;
  loadSchedules(): Promise<void>;
  openScheduleEditor(target: {
    scheduleId?: string;
    action?: { kind: string; automationId: string };
  }): void;
  openSettingsTab(target: { category: string }): void;
  prepareAppQuit(): string;
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
  await page.clock.setFixedTime(NOW);
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
async function bootWithTerminals(
  page: Page,
  theme: string,
  count: number,
  scenario: VisualScenario = {}
): Promise<void> {
  await boot(page, theme, { terminal: true, ...scenario });
  for (let i = 0; i < count; i += 1) {
    if ((await page.locator("[data-testid^='tab-close-']").count()) <= i) {
      await page.locator(id("terminal-view-new-terminal")).click();
    }
  }
  await page.locator(".xterm").last().waitFor();
}

/** Print `text` in the `n`th terminal, as its session would. */
async function print(page: Page, n: number, text: string): Promise<void> {
  await page.evaluate(
    async ([id, data]) => {
      await window.__visual.emit("terminal-output", { session_id: id, data: btoa(data) });
    },
    [n === 1 ? VISUAL_SESSION_ID : `${VISUAL_SESSION_ID}-${n}`, text]
  );
}

/** Start recording from the toolbar and type `keys`, each after `prompt`. */
async function record(page: Page, keys: [string, string][]): Promise<void> {
  const recording = await page.evaluate(
    () => (window.__visual.store.getState() as unknown as GalleryState).recording !== null
  );
  if (!recording) {
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

/** Quit the app, as its menu does. */
async function requestQuit(page: Page): Promise<void> {
  const asked = await page.evaluate(() =>
    (window.__visual.store.getState() as unknown as GalleryState).prepareAppQuit()
  );
  expect(asked).toBe("prompt");
  await page.locator(QUIT).waitFor();
}

const QUIT = id("close-window-decision-dialog");
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
      test.use({ viewport, timezoneId: "UTC", locale: "en-US" });

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
        for (const automationId of ["full", "off-hotkey"]) {
          await page.locator(id(`automation-arm-toggle-${automationId}`)).click();
          await expect(page.locator(id(`automation-armed-${automationId}`))).toHaveAttribute(
            "data-armed",
            "false"
          );
        }
        await page.locator(id("automation-armed-off-hotkey")).scrollIntoViewIfNeeded();
        await shot(page, "sidebar--switched-off", SIDEBAR);
        await page.locator(id("automation-search")).fill("kubernetes");
        await page.locator(id("automation-no-results")).waitFor();
        await shot(page, "sidebar--search-empty", SIDEBAR);
      });

      test("sidebar, selected", async ({ page }) => {
        await boot(page, theme);
        await page.locator(id("automation-name-full")).click();
        await expect(page.locator(id("automation-edit-full"))).toBeVisible();
        await shot(page, "sidebar--selected", SIDEBAR);
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
        await page.locator(id("terminal-view-active-playback")).waitFor();
        // Only the terminal shows it: the sidebar is on something else.
        await page.locator(id("activity-bar-connections")).click();
        await shot(page, "run--running", id("terminal-view-toolbar-actions"));
      });

      test("running elsewhere, two at once", async ({ page }) => {
        await bootWithTerminals(page, theme, 3, { automationData: running });
        await runOn(page, "health");
        await page.locator(id("run-targets-run")).click();
        await page.locator("[role=tab]").first().click();
        await expect(page.locator(id("automation-running-health"))).toBeVisible();
        await shot(page, "sidebar--running", SIDEBAR);
        await runOn(page, "typing");
        await page.locator(id("run-targets-target-pick")).click();
        await page
          .locator(`${id("run-targets-terminal-list")} [role=checkbox]`)
          .nth(1)
          .click();
        await page.locator(id("run-targets-run")).click();
        await page.locator(id("run-targets-run")).click();
        await expect(page.locator(id("automation-stop-typing"))).toHaveText("Stop all 2");
        await shot(page, "sidebar--two-runs", SIDEBAR);
      });

      test("waiting, and quit", async ({ page }) => {
        await bootWithTerminals(page, theme, 2, { automationData: running });
        await page.locator(id("automation-start-password")).click();
        await page.locator("[role=tab]").first().click();
        await page.locator(id("automation-start-typing")).click();
        await expect(page.locator(id("automation-running-password"))).toHaveText("Waiting for you");
        await expect(page.locator(id("automation-item-typing"))).toContainText("50 % typed");
        await shot(page, "sidebar--waiting", SIDEBAR);
        await requestQuit(page);
        await shot(page, "run--quit", QUIT);
      });

      test("replacing and stopping a run", async ({ page }) => {
        await bootWithTerminals(page, theme, 1, { automationData: running });
        await page.locator(id("automation-start-health")).click();
        await expect(page.locator(id("automation-running-health"))).toBeVisible();
        await page.locator(id("automation-start-missing")).click();
        await page.locator(id("run-replace-dialog")).waitFor();
        await shot(page, "run--replace", id("run-replace-dialog"));
        await page.locator(id("run-replace-cancel")).click();
        await page.locator(id("automation-stop-health")).click();
        await expect(page.locator(id("toast-region"))).toContainText("stopped");
        await shot(page, "run--stopped", SIDEBAR);
      });

      test("a wait that ended", async ({ page }) => {
        const ended = run({
          id: "w1",
          automationId: "password",
          automationName: "Restart the web server",
          status: "failed",
          stepsCompleted: 1,
          total: 3,
          failedStepIndex: 1,
          error: "nobody pressed Continue within 5 minutes; nothing more was typed",
        });
        await boot(page, theme, { automationData: { ...running, runs: [ended] } });
        await page.locator(id("automation-failed-password")).click();
        await page.locator(id("automation-run-toggle-w1")).click();
        await page.locator(id("automation-run-next-w1")).waitFor();
        await shot(page, "run--wait-ended", SIDEBAR);
      });

      test("running a program", async ({ page }) => {
        await bootWithTerminals(page, theme, 1, {
          automationData: running,
          localProcessAsk: true,
        });
        await page.locator(id("automation-start-program")).click();
        await page.locator("[role=dialog]").waitFor();
        await shot(page, "run--program", "[role=dialog]");
        await page.locator(id("local-process-auth-cancel")).click();
        await expect(page.locator(id("toast-region"))).toContainText("failed at step 1");
        await shot(page, "run--program-refused", SIDEBAR);
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
        await page.locator(id("automation-editor-when-toggle")).click();
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
        await shot(page, "editor--blocked-collapsed", EDITOR);
        await page.locator(id("automation-editor-step-toggle-4")).click();
        await page.locator(id("automation-editor-step-4")).scrollIntoViewIfNeeded();
        await shot(page, "editor--local-process-off", EDITOR);
        await page.locator(id("automation-editor-step-open-settings-4")).click();
        await page.locator(id("automation-editor-aside")).waitFor();
        await page.locator(id("settings-experimental-features")).waitFor();
        await shot(page, "editor--settings-aside", id("automation-editor-aside"));
        await page.locator(id("automation-editor-aside-return")).click();
        await page.locator(EDITOR).waitFor();
      });

      const bodies = { automations: BODIES, runs: RUNS, schedules: SCHEDULES };

      test("editor, step bodies", async ({ page }) => {
        await boot(page, theme, { automationData: bodies });
        await edit(page, "bodies");
        const open = async (step: number, state: State) => {
          const toggle = page.locator(id(`automation-editor-step-toggle-${step}`));
          await toggle.click();
          await page.locator(id(`automation-editor-step-${step}`)).scrollIntoViewIfNeeded();
          await shot(page, state, EDITOR);
          await toggle.click();
        };
        await open(0, "editor--wait-step");
        await open(1, "editor--condition-step");
        await open(2, "editor--loop-step");
        await open(3, "editor--wait-for-user-step");
        await page.locator(id("automation-editor-step-more-1")).click();
        await page.locator(id("automation-editor-step-add-below-1")).press("ArrowRight");
        await page.locator(id("automation-editor-step-add-below-1-wait")).waitFor();
        await expect
          .poll(async () => {
            const menus = page.locator("[role=menu]");
            const box = await menus.last().boundingBox();
            return box !== null && box.y >= 0 && box.y + box.height <= viewport.height;
          })
          .toBe(true);
        await shot(page, "editor--step-menu", EDITOR);
        await page.keyboard.press("Escape");
        await page.locator("[role=menu]").first().waitFor({ state: "hidden" });
        await expect(page.locator(id("automation-editor-step-more-1"))).toBeFocused();
        await page.locator(id("automation-editor-insert-step-2")).focus();
        await shot(page, "editor--insert-step", EDITOR);
      });

      test("editor, triggers", async ({ page }) => {
        await boot(page, theme, { automationData: bodies });
        await edit(page, "bodies");
        await page.locator(id("automation-editor-when-toggle")).click();
        await page.locator(id("automation-editor-trigger-1")).scrollIntoViewIfNeeded();
        await shot(page, "editor--on-connect", EDITOR);
        await page.locator(id("automation-editor-add-trigger")).click();
        await page.locator(id("automation-editor-add-schedule")).waitFor();
        await expect
          .poll(async () => {
            const box = await page.locator("[role=menu]").boundingBox();
            return box !== null && box.y >= 0 && box.y + box.height <= viewport.height;
          })
          .toBe(true);
        await shot(page, "editor--add-trigger", EDITOR);
        await page.keyboard.press("Escape");
        const hotkey = page.locator(id("automation-trigger-binding-0"));
        await hotkey.scrollIntoViewIfNeeded();
        await hotkey.press("Control+Shift+P");
        await expect(page.locator(id("automation-editor-trigger-0"))).toContainText("is used by");
        await shot(page, "editor--hotkey", EDITOR);
        await hotkey.press("Control+Alt+R");
        await expect(page.locator(id("automation-editor-trigger-0"))).toContainText("“Release”");
        await shot(page, "editor--hotkey-other", EDITOR);
      });

      test("editor, keys", async ({ page }) => {
        await boot(page, theme);
        await edit(page, "keys");
        await page.locator(id("automation-editor-step-toggle-0")).click();
        await page.locator(id("automation-editor-keys-more-0")).click();
        await shot(page, "editor--more-keys", EDITOR);
      });

      test("recording", async ({ page }) => {
        await bootWithTerminals(page, theme, 1);
        await record(page, [["sudo -v\r", "$ "]]);
        await shot(page, "recording--chip", id("terminal-view-active-recording"));
        await record(page, [["h", "[sudo] password for arne: "]]);
        await page.locator(id("recording-bar-prompt")).waitFor();
        await shot(page, "recording--password-prompt", id("recording-bar-prompt"));
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
        await page.keyboard.press("Escape");
        await requestQuit(page);
        await shot(page, "recording--quit", QUIT);
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

      test("run, a password", async ({ page }) => {
        await bootWithTerminals(page, theme, 2, { automationData: bodies });
        await page.locator(id("automation-start-password")).click();
        const bar = page.locator(id("automation-waits"));
        await bar.waitFor();
        await shot(page, "run--password-wait", id("automation-waits"));
        await print(page, 2, "[sudo] password for arne: ");
        await bar.locator("[data-testid^='automation-wait-continue-']").click();
        await expect(bar).toContainText("still asks for a password");
        await shot(page, "run--password-still-asked", id("automation-waits"));
        await page.locator("[role=tab]").first().click();
        await bar.locator("[data-testid^='automation-wait-show-']").waitFor();
        await expect(bar.locator("[data-testid^='automation-wait-continue-']")).toHaveCount(0);
        await shot(page, "run--password-wait-elsewhere", id("automation-waits"));
        await bar.locator("[data-testid^='automation-wait-show-']").click();
        await print(page, 2, "\r\n$ ");
        await expect(bar).not.toContainText("still asks");
        await shot(page, "run--password-typed", id("automation-waits"));
        await bar.locator("[data-testid^='automation-wait-stop-']").click();
        await bar.waitFor({ state: "hidden" });
      });

      test("run, values", async ({ page }) => {
        await bootWithTerminals(page, theme, 1, { automationData: bodies });
        await page.locator(id("automation-start-bodies")).click();
        await page.locator("[role=dialog]").waitFor();
        await shot(page, "run--values", "[role=dialog]");
      });

      test("run, failed", async ({ page }) => {
        await bootWithTerminals(page, theme, 1, { automationData: running });
        await page.locator(id("automation-start-missing")).click();
        await expect(page.locator(id("toast-region"))).toContainText("failed at step 2");
        await shot(page, "run--failed", SIDEBAR);
      });

      test("history", async ({ page }) => {
        await boot(page, theme);
        await page.locator(id("automation-history-toggle")).click();
        await page.locator(id("automation-run-toggle-r1")).click();
        await page.locator(id("automation-run-error-r1")).waitFor();
        await shot(page, "run--history", SIDEBAR);
      });

      /** Boot with these schedules and open their section. */
      async function bootSchedules(
        page: Page,
        schedules: unknown,
        { automations = LIBRARY, runs = RUNS } = {}
      ): Promise<void> {
        await boot(page, theme, {
          automationData: { automations, runs, schedules: schedules as typeof SCHEDULES },
        });
        await page.locator(id("schedules-section-toggle")).click();
        await page.locator(id("schedule-enable-s1")).waitFor();
      }

      /** Open the editor of a new schedule for an automation. */
      async function newSchedule(page: Page, automationId: string): Promise<void> {
        await page.evaluate((automation) => {
          const state = window.__visual.store.getState() as unknown as GalleryState;
          state.openScheduleEditor({ action: { kind: "automation", automationId: automation } });
        }, automationId);
        await page.locator(id("schedule-editor-dialog")).waitFor();
      }
      const SCHEDULE_EDITOR = id("schedule-editor-dialog");

      test("editor, trigger of a deleted connection", async ({ page }) => {
        await boot(page, theme, {
          automationData: {
            automations: LIBRARY.map((a) =>
              (a as { id?: string }).id === "full"
                ? {
                    ...a,
                    triggers: [
                      {
                        kind: "on-output-match",
                        connectionIds: ["Work/Old Build Box"],
                        pattern: "Continue?",
                      },
                    ],
                  }
                : a
            ),
            runs: RUNS,
            schedules: SCHEDULES,
          },
        });
        await edit(page, "full");
        await page.locator(id("automation-editor-when-toggle")).click();
        await page.locator(id("automation-trigger-connection-0-none")).scrollIntoViewIfNeeded();
        await shot(page, "editor--triggers-deleted", EDITOR);
      });

      test("schedules", async ({ page }) => {
        await bootSchedules(page, SCHEDULES);
        await page.locator(id("schedule-last-s1")).waitFor();
        await shot(page, "schedules--list", SIDEBAR);
        await page.locator(id("schedule-edit-s1")).click();
        await page.locator(SCHEDULE_EDITOR).waitFor();
        await page.getByText("On. Next run: tomorrow 02:00 on Build Box.").waitFor();
        await shot(page, "schedules--editor", SCHEDULE_EDITOR);
      });

      test("schedules, switched on for the first time", async ({ page }) => {
        await bootSchedules(page, SCHEDULES);
        await page.locator(id("schedule-enable-s2")).click();
        await page.locator(id("schedule-confirm-next")).waitFor();
        await shot(page, "schedules--first-on", id("schedule-enable-confirm"));
        await page.locator(id("schedule-enable-confirm-cancel")).click();
        await page.evaluate(() => {
          const store = window.__visual.store as unknown as {
            getState(): { schedules: { id: string; connectIfNeeded?: boolean }[] };
            setState(partial: unknown): void;
          };
          store.setState({
            schedules: store
              .getState()
              .schedules.map((s) => (s.id === "s2" ? { ...s, connectIfNeeded: true } : s)),
          });
        });
        await page.locator(id("schedule-enable-s2")).click();
        await page.locator(id("schedule-confirm-connects")).waitFor();
        await shot(page, "schedules--first-on-connects", id("schedule-enable-confirm"));
      });

      test("schedules, paused", async ({ page }) => {
        await bootSchedules(page, { ...SCHEDULES, paused: true });
        await expect(page.locator(id("schedule-status-s1"))).toHaveText("Paused");
        await shot(page, "schedules--paused", SIDEBAR);
      });

      test("schedules, missed and failed", async ({ page }) => {
        await bootSchedules(page, TROUBLED, { runs: TROUBLED_RUNS });
        await page.locator(id("schedule-last-s1")).waitFor();
        await shot(page, "schedules--missed", SIDEBAR);
        await page.locator(id("schedule-last-history-s1")).click();
        const gap = page.locator("[data-testid^='automation-gap-toggle-s1']");
        await gap.click();
        await page.locator("[data-testid^='automation-gap-reason-s1']").waitFor();
        await shot(page, "schedules--history", SIDEBAR);
      });

      test("schedules, a deleted connection", async ({ page }) => {
        await bootSchedules(page, DELETED);
        await page.locator(id("schedule-blocked-s1")).waitFor();
        await shot(page, "schedules--deleted", SIDEBAR);
        await page.locator(id("schedule-edit-s1")).click();
        await page.locator(id("schedule-editor-connection-deleted-0")).waitFor();
        await shot(page, "schedules--editor-deleted", SCHEDULE_EDITOR);
      });

      test("schedules, a new one", async ({ page }) => {
        await bootSchedules(page, SCHEDULES);
        await newSchedule(page, "failed");
        await shot(page, "schedules--new", SCHEDULE_EDITOR);
        await page.locator(id("schedule-editor-save")).click({ force: true });
        await page.getByText("Choose what to do with a closed connection.").waitFor();
        await shot(page, "schedules--new-refused", SCHEDULE_EDITOR);
        await page.locator(id("schedule-editor-name")).fill("Backup at night");
        await page.locator(id(`schedule-editor-connection-${BUILD_BOX}`)).click();
        await page.locator(id("schedule-editor-closed-connect")).click();
        await page.locator(id("schedule-editor-rule-kind")).click();
        await page.getByRole("option", { name: "Daily" }).click();
        await page.locator(id("schedule-editor-time")).fill("02:00");
        await page.getByText("When switched on: next run tomorrow 02:00 on Build Box.").waitFor();
        await shot(page, "schedules--new-nightly", SCHEDULE_EDITOR);
        await page.locator(id("schedule-editor-save")).click();
        await page.locator(SCHEDULE_EDITOR).waitFor({ state: "hidden" });
        await page.getByText("Backup at night", { exact: true }).scrollIntoViewIfNeeded();
        await shot(page, "schedules--saved", SIDEBAR);
      });

      test("schedules, an automation that cannot run alone", async ({ page }) => {
        await bootSchedules(page, SCHEDULES, { automations: [...UNATTENDED, ...BODIES] });
        await newSchedule(page, "asks");
        await page.locator(id("schedule-editor-automation-note")).waitFor();
        await shot(page, "schedules--editor-asks", SCHEDULE_EDITOR);
        await page.locator(id("schedule-editor-cancel")).click();
        await newSchedule(page, "sudo");
        await page.locator(id("schedule-editor-automation-note")).waitFor();
        await shot(page, "schedules--editor-password", SCHEDULE_EDITOR);
        await page.locator(id("schedule-editor-cancel")).click();
        await newSchedule(page, "password");
        await expect(page.locator(id("schedule-editor-automation-note"))).toContainText(
          "waits for you"
        );
        await shot(page, "schedules--editor-waits", SCHEDULE_EDITOR);
      });

      test("palette", async ({ page }) => {
        await bootWithTerminals(page, theme, 1);
        await page.evaluate(() =>
          (window.__visual.store.getState() as unknown as GalleryState).setCommandPaletteOpen(true)
        );
        await page.locator(id("command-palette-input")).fill("re");
        await page.locator(id("command-palette-item-automation:full")).waitFor();
        await shot(page, "palette--automations", id("command-palette"));
        await page.locator(id("command-palette-input")).fill("night");
        await expect(page.locator(id("command-palette-item-automation:off-trigger"))).toContainText(
          "triggers off"
        );
        await shot(page, "palette--triggers-off", id("command-palette"));
      });

      test("palette, no terminal", async ({ page }) => {
        await boot(page, theme);
        await page.evaluate(() =>
          (window.__visual.store.getState() as unknown as GalleryState).setCommandPaletteOpen(true)
        );
        await page.locator(id("command-palette-input")).fill("re");
        await page.locator(id("command-palette-item-automation:full")).waitFor();
        await shot(page, "palette--no-terminal", id("command-palette"));
        await page.locator(id("command-palette-input")).fill("newer");
        await page.locator(id("command-palette-item-automation:unknown")).waitFor();
        await shot(page, "palette--cannot-run", id("command-palette"));
      });

      test("import", async ({ page }) => {
        await boot(page, theme, { openFile: { path: "/tmp/in.json", text: IMPORT } });
        await page.locator(id("automation-new-btn")).click();
        await page.locator(id("automation-files-btn")).waitFor();
        await shot(page, "import--entry", "[role=menu]");
        await page.locator(id("automation-files-btn")).click();
        await page.locator(id("import-migration-automations-import-btn")).click();
        await expect(page.locator(id("automation-import-dialog"))).toContainText("Imported 2 of 3");
        await shot(page, "import--notes", id("automation-import-dialog"));
        await page.locator(id("automation-import-show")).click();
        await page.locator(SIDEBAR).waitFor();
        await page.getByText("Imported in part", { exact: false }).scrollIntoViewIfNeeded();
        await shot(page, "import--shown", SIDEBAR);
        await page.locator(id("automation-item-keys")).click({ button: "right" });
        await page.locator(id("automation-menu-export-keys")).waitFor();
        await shot(page, "import--export", "[role=menu]");
      });
    });
  }
}

// What a 600 px high window leaves at 140 % zoom: less than the menu needs.
test("the add step menu fits into a short dialog and scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 428 });
  await boot(page, "dark");
  await newAutomation(page, "steps");
  await page.locator(id("automation-editor-add-step")).click();
  const menu = page.locator("[role=menu]");
  await menu.waitFor();
  const dialog = (await page.locator(EDITOR).boundingBox())!;
  await expect.poll(async () => (await menu.boundingBox())!.y).toBeGreaterThanOrEqual(dialog.y);
  const box = (await menu.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(dialog.y + dialog.height);
  for (const step of ["type-keys", "run-local-process"]) {
    const entry = page.locator(id(`automation-editor-add-step-${step}`));
    await entry.scrollIntoViewIfNeeded();
    const at = (await entry.boundingBox())!;
    expect(at.y).toBeGreaterThanOrEqual(box.y);
    expect(at.y + at.height).toBeLessThanOrEqual(box.y + box.height);
  }
});
