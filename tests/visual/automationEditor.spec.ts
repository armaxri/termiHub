/**
 * The automation editor (#5818, slice 7) in the rendered app, at the minimum
 * window and the usual one: the dialog fits, its collapsed steps are one line
 * each and above the footer (R-076), an opened Type keys step and the triggers
 * fit its width, and the Add step menu is laid out inside the dialog.
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
const DIALOG = "[data-testid=automation-editor-dialog]";
const id = (testId: string) => `[data-testid="${testId}"]`;

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
}

/** Open the app on the Automations sidebar with the seeded library. */
async function openAutomations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__VISUAL_SCENARIO__ = { populated: true };
  });
  await page.goto("/tests/visual/harness/index.html");
  await page.waitForFunction(() => window.__visual !== undefined);
  await page.locator("[data-testid=sidebar]").waitFor();
  await page.evaluate(() => {
    const state = window.__visual.store.getState() as unknown as {
      sidebarView: string;
      setSidebarView(view: string): void;
      loadAutomations(): Promise<void>;
    };
    if (state.sidebarView !== "automations") state.setSidebarView("automations");
    return state.loadAutomations();
  });
}

/** Open the editor on a stored automation from its row. */
async function edit(page: Page, automationId: string): Promise<void> {
  await page.locator(id(`automation-item-${automationId}`)).hover();
  await page.locator(id(`automation-edit-${automationId}`)).click();
  await page.locator(DIALOG).waitFor();
}

for (const viewport of [
  { width: 800, height: 600 },
  { width: 1280, height: 800 },
]) {
  const size = `${viewport.width}x${viewport.height}`;

  test.describe(`automation editor at ${size}`, () => {
    test.use({ viewport });

    /** Audit the dialog, check that it fits the window, and screenshot it. */
    async function check(page: Page, name: string): Promise<void> {
      await settle(page);
      const issues = await page.evaluate(auditLayout, {
        root: DIALOG,
        styledClasses: STYLED_CLASSES,
      });
      const box = (await page.locator(DIALOG).boundingBox())!;
      const path = join(SCREENS, "automation-editor", `${name}-${size}.png`);
      await page.screenshot({ path });
      await test.info().attach(`${name} (${size})`, { path, contentType: "image/png" });
      expect.soft(issues, name).toEqual([]);
      expect.soft(box.y).toBeGreaterThanOrEqual(0);
      expect.soft(box.y + box.height).toBeLessThanOrEqual(viewport.height);
      const body = await page
        .locator(`${DIALOG} .ui-modal__body`)
        .evaluate((el) => [el.scrollWidth, el.clientWidth]);
      expect.soft(body[0], `${name} is wider than the dialog`).toBeLessThanOrEqual(body[1]);
    }

    test("keeps the steps of a stored automation in view", async ({ page }) => {
      await openAutomations(page);
      await edit(page, "wf-4");
      const save = (await page.locator(id("automation-editor-save")).boundingBox())!;
      const rows = page.locator(".automation-steps__list > .automation-step");
      expect(await rows.count()).toBe(5);
      for (const row of await rows.all()) {
        const box = (await row.boundingBox())!;
        expect(box.height).toBeLessThanOrEqual(48);
        expect(box.y + box.height).toBeLessThanOrEqual(save.y);
      }
      await check(page, "steps");
      await page.locator(id("automation-editor-add-step")).click();
      await page.locator(id("automation-editor-add-step-loop")).waitFor();
      await check(page, "add-step");
      await page.keyboard.press("Escape");
      await page.locator(id("automation-editor-steps-toggle-all")).click();
      await check(page, "expanded");
    });

    test("a recorded automation shows its keys and speed on request", async ({ page }) => {
      await openAutomations(page);
      await edit(page, "m-1");
      await check(page, "recorded");
      await page.locator(id("automation-editor-step-toggle-0")).click();
      await check(page, "keys");
      await page.locator(id("automation-editor-step-more-0")).click();
      await page.locator(id("automation-editor-step-delete-0")).waitFor();
      await check(page, "step-menu");
    });

    test("triggers show their settings under themselves", async ({ page }) => {
      await openAutomations(page);
      await edit(page, "wf-2");
      await page.locator(id("automation-editor-when-toggle")).click();
      await page.locator(id("automation-trigger-pattern-0")).scrollIntoViewIfNeeded();
      await check(page, "triggers");
    });

    test("a save attempt shows every reason", async ({ page }) => {
      await openAutomations(page);
      await page.locator(id("automation-new-btn")).click();
      await page.locator(id("automation-new-keys")).click();
      await page.locator(DIALOG).waitFor();
      await check(page, "new-keys");
      await expect(page.locator(id("automation-editor-footer-note"))).toContainText("To save:");
      await page.locator(id("automation-editor-save-run")).click();
      await expect(page.locator(id("automation-editor-keys-error-0-0"))).toBeVisible();
      await expect(page.locator(id("automation-editor-name"))).toBeFocused();
      await check(page, "new-keys-errors");
    });

    test("the schedule editor opens over it, and Escape closes only that", async ({ page }) => {
      await openAutomations(page);
      await edit(page, "wf-2");
      await page.locator(id("automation-editor-when-toggle")).click();
      await page.locator(id("automation-editor-add-trigger")).click();
      await page.locator(id("automation-editor-add-schedule")).click();
      const schedule = page.locator(id("schedule-editor-dialog"));
      await schedule.waitFor();
      await page.locator(id("schedule-editor-name")).fill("Every morning");
      await settle(page);
      const path = join(SCREENS, "automation-editor", `schedule-${size}.png`);
      await page.screenshot({ path });
      await page.keyboard.press("Escape");
      await page.locator(id("unsaved-changes-just-close")).click();
      await expect(schedule).toBeHidden();
      await expect(page.locator(DIALOG)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator(DIALOG)).toBeHidden();
    });

    test("steps are reordered, deleted and brought back by keyboard alone", async ({ page }) => {
      await openAutomations(page);
      await edit(page, "wf-4");
      const kinds = () =>
        page
          .locator(".automation-steps__list > .automation-step .automation-step__kind")
          .evaluateAll((els) => els.map((el) => el.getAttribute("data-kind")));
      await page.locator(id("automation-editor-step-grip-1")).focus();
      await page.keyboard.press("ArrowUp");
      await expect(page.locator(id("automation-editor-step-grip-0"))).toBeFocused();
      expect((await kinds()).slice(0, 2)).toEqual(["send-command", "type-keys"]);
      await page.locator(id("automation-editor-step-more-4")).focus();
      await page.keyboard.press("Enter");
      await page.locator(id("automation-editor-step-delete-4")).waitFor();
      await page.keyboard.press("End");
      await expect(page.locator(id("automation-editor-step-delete-4"))).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.locator(id("automation-editor-step-toggle-3"))).toBeFocused();
      expect(await kinds()).toHaveLength(4);
      await page.locator(id("automation-editor-step-undo")).focus();
      await page.keyboard.press("Enter");
      expect(await kinds()).toHaveLength(5);
      await page.locator(id("automation-editor-step-more-0")).focus();
      await page.keyboard.press("Enter");
      await page.locator(id("automation-editor-step-failure-menu-0")).waitFor();
      await page.keyboard.press("Enter");
      await expect(page.locator(id("automation-editor-step-on-failure-0"))).toBeFocused();
      // Escape in an open menu closes the menu, not the editor.
      await page.locator(id("automation-editor-add-step")).focus();
      await page.keyboard.press("Enter");
      await page.locator(id("automation-editor-add-step-wait")).waitFor();
      await page.keyboard.press("Escape");
      await expect(page.locator(DIALOG)).toBeVisible();
      await expect(page.locator(id("automation-editor-add-step"))).toBeFocused();
    });

    test("a step is dragged by its handle", async ({ page }) => {
      await openAutomations(page);
      await edit(page, "wf-4");
      const from = (await page.locator(id("automation-editor-step-grip-0")).boundingBox())!;
      const to = (await page.locator(id("automation-editor-step-2")).boundingBox())!;
      await page.mouse.move(from.x + 5, from.y + 5);
      await page.mouse.down();
      await page.mouse.move(from.x + 5, from.y + 30, { steps: 4 });
      await page.mouse.move(from.x + 5, to.y + to.height / 2, { steps: 8 });
      await page.mouse.up();
      await expect(page.locator(id("automation-editor-step-kind-2"))).toHaveAttribute(
        "data-kind",
        "type-keys"
      );
    });
  });
}
