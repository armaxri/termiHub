/**
 * Automations as files and in the command palette (#5818, slice 11) in the
 * rendered app, at the minimum window and the usual one: the settings section,
 * the dialog that says what an import brought in, and the palette's rows.
 *
 * Screenshots land in the usual screens/ folder for human review.
 */

import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

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
const id = (testId: string) => `[data-testid="${testId}"]`;
const DIALOG = id("automation-import-dialog");

/** A file that has everything an import tells the user about. */
const FILE = JSON.stringify({
  version: 1,
  automations: [
    {
      name: "Nightly backup of the Frankfurt replicas",
      steps: [],
      triggers: [{ kind: "hotkey", binding: "Ctrl+Alt+B" }],
    },
    {
      name: "Answer the confirmation",
      steps: [],
      triggers: [{ kind: "on-connect", connectionIds: ["c"] }],
    },
    { name: "Odd one", steps: [{ kind: "teleport" }] },
    { name: "Partly known", steps: [], later: true },
    { name: "Notify", steps: [{ kind: "run-local-process", program: "notify-send", args: [] }] },
    {
      name: "Deploy",
      steps: [
        { kind: "run-script", script: "make", sourcePath: "/home/ops/deploy/scripts/release.sh" },
        { kind: "run-automation", automationId: "gone" },
      ],
    },
  ],
});

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
}

async function boot(page: Page, scenario: Record<string, unknown>): Promise<void> {
  await page.addInitScript((s) => {
    window.__VISUAL_SCENARIO__ = s;
  }, scenario);
  await page.goto("/tests/visual/harness/index.html");
  await page.waitForFunction(() => window.__visual !== undefined);
  await page.locator("[data-testid=sidebar]").waitFor();
  await page.evaluate(() => window.__visual.store.getState().loadAutomations());
}

for (const viewport of [
  { width: 800, height: 600 },
  { width: 1280, height: 800 },
]) {
  const size = `${viewport.width}x${viewport.height}`;

  test.describe(`automation files at ${size}`, () => {
    test.use({ viewport });

    /** Audit `root`, check that it fits the window, and screenshot it. */
    async function check(page: Page, name: string, root: string): Promise<void> {
      await settle(page);
      const path = join(SCREENS, "automation-files", `${name}-${size}.png`);
      await page.screenshot({ path });
      await test.info().attach(`${name} (${size})`, { path, contentType: "image/png" });
      const issues = await page.evaluate(auditLayout, { root, styledClasses: STYLED_CLASSES });
      expect.soft(issues, name).toEqual([]);
      const box = (await page.locator(root).boundingBox())!;
      expect.soft(box.x).toBeGreaterThanOrEqual(0);
      expect.soft(box.y).toBeGreaterThanOrEqual(0);
      expect.soft(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect.soft(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    }

    test("the sidebar leads to import, which says what came in", async ({ page }) => {
      await boot(page, { populated: true, openFile: { path: "/tmp/in.json", text: FILE } });
      await page.evaluate(() => {
        const state = window.__visual.store.getState() as unknown as {
          sidebarView: string;
          setSidebarView(view: string): void;
        };
        if (state.sidebarView !== "automations") state.setSidebarView("automations");
      });
      await page.locator(id("automation-new-btn")).click();
      await page.locator(id("automation-files-btn")).waitFor();
      await check(page, "new-menu", id("automation-sidebar"));
      await page.locator(id("automation-files-btn")).click();
      const section = page.locator(id("import-migration-automations"));
      await section.scrollIntoViewIfNeeded();
      await check(page, "settings", id("import-migration-automations"));
      await page.locator(id("import-migration-automations-import-btn")).click();
      await page.locator(DIALOG).waitFor();
      const dialog = page.locator(DIALOG);
      await expect(dialog).toContainText("Imported 4 of 5 automations");
      await expect(page.locator(id("automation-import-refused-Odd one"))).toContainText("teleport");
      for (const [name, says] of [
        ["Partly known", "Left out, because this version does not know it: later"],
        ["Notify", "Runs a program on this computer"],
        ["Deploy", "/home/ops/deploy/scripts/release.sh"],
        ["Deploy", "Runs an automation that is not in the file"],
      ]) {
        await expect(page.locator(id(`automation-import-entry-${name}`))).toContainText(says);
      }
      await expect(dialog).toContainText("Triggers off: On connect");
      await check(page, "imported", DIALOG);
    });

    test("the palette names automations and where they run", async ({ page }) => {
      await boot(page, { populated: true, terminal: true });
      if ((await page.locator(".xterm").count()) === 0) {
        await page.locator(id("terminal-view-new-terminal")).click();
      }
      await page.locator(".xterm").first().waitFor();
      await page.evaluate(() => window.__visual.store.getState().setCommandPaletteOpen(true));
      await page.locator(id("command-palette-input")).fill("run workflow");
      await expect(page.locator(id("command-palette-item-automation:wf-4"))).toBeVisible();
      await check(page, "palette", id("command-palette"));
    });
  });
}
