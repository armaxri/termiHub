/**
 * #6021 (R-068): a line an automation typed is marked in the terminal, in both
 * themes, at the minimum window and the usual one; the user's own line is not.
 *
 * The shots land in `test-results/screens/automation-mark/` with `index.json`:
 * what the user wants to know in each.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { VISUAL_SESSION_ID } from "./harness/interactionIds";
import type { VisualHandle } from "./harness/visualHandle";
import { SCREENS } from "./surfaces";

declare global {
  interface Window {
    __visual: VisualHandle;
  }
}

const DIR = join(SCREENS, "automation-mark");
const WINDOWS = [
  { width: 800, height: 600 },
  { width: 1280, height: 800 },
];
const THEMES = ["dark", "light"];
const STATES = {
  "terminal--marked":
    "A scheduled automation typed into this terminal at night: which lines did it type, and which did you?",
  "terminal--marked-narrow":
    "The window was made narrower: is the mark still at the line, and at its end?",
} as const;

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
}

/** Print `text` in the terminal, as its session would. */
async function print(page: Page, text: string): Promise<void> {
  await page.evaluate(
    async ([id, data]) => {
      await window.__visual.emit("terminal-output", { session_id: id, data: btoa(data) });
    },
    [VISUAL_SESSION_ID, text]
  );
  await settle(page);
}

/** The automation starts a line in the terminal: what its run does before it types. */
async function automationStartsLine(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const tabId = document
      .querySelector("[data-testid^='tab-close-']")!
      .getAttribute("data-testid")!
      .replace("tab-close-", "");
    const marks = (await import(
      /* @vite-ignore */ "/src/services/automationTypingMarks.ts"
    )) as typeof import("../../src/services/automationTypingMarks");
    const send = marks.markAutomationInput(() => true, {
      automationId: "nightly",
      name: "Nightly deploy",
      origin: "scheduled",
    });
    send(tabId, "./deploy.sh staging\r");
  });
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
  for (const theme of THEMES) {
    const where = `${viewport.width}x${viewport.height}--${theme}`;
    test(`a line an automation typed is marked (${where})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript(() => {
        window.__VISUAL_SCENARIO__ = { populated: true, terminal: true };
      });
      await page.goto("/tests/visual/harness/index.html");
      await page.waitForFunction(() => window.__visual !== undefined);
      await page.locator("[data-testid=sidebar]").waitFor();
      await page.evaluate((t) => window.__visual.applyTheme(t), theme);
      if ((await page.locator("[data-testid^='tab-close-']").count()) === 0) {
        await page.locator("[data-testid=terminal-view-new-terminal]").click();
      }
      await page.locator(".xterm").last().waitFor();

      // The user's own command, then the automation's, then the user's again.
      await print(page, "ana@build:~$ git pull\r\nAlready up to date.\r\nana@build:~$ ");
      await automationStartsLine(page);
      await print(
        page,
        "./deploy.sh staging\r\nDeploying build 418 to staging... done.\r\nana@build:~$ ls\r\nREADME.md  deploy.sh\r\nana@build:~$ "
      );
      const badge = page.locator(".terminal-automation-badge");
      await expect(badge).toHaveCount(1);
      await expect(badge).toHaveAttribute("title", /“Nightly deploy”, on its schedule/);
      await expect(page.locator(".terminal-automation-mark")).toHaveCount(1);
      await page.mouse.move(viewport.width - 2, viewport.height / 2);
      await settle(page);
      await page.screenshot({ path: join(DIR, `terminal--marked--${where}.png`) });

      await page.setViewportSize({ width: viewport.width - 200, height: viewport.height });
      await settle(page);
      await expect(badge).toHaveCount(1);
      const screen = await page.locator(".xterm-screen").last().boundingBox();
      const box = await badge.boundingBox();
      // At the row's right end, inside the screen, after the resize.
      expect(box!.x + box!.width).toBeLessThanOrEqual(screen!.x + screen!.width + 1);
      expect(box!.x + box!.width).toBeGreaterThan(screen!.x + screen!.width - 20);
      await page.screenshot({ path: join(DIR, `terminal--marked-narrow--${where}.png`) });
    });
  }
}
