/**
 * Recording into an automation (#5818, slice 8) in the rendered app, at the
 * minimum window and the usual one: the toolbar chip and the tab's badge while
 * recording, the dialog a stopped recording opens, the bar that keeps it, and
 * the editor's Record steps with its way back.
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

/** The recording part of the app store. */
interface RecordingState {
  recording: { tabId: string } | null;
  recordInput(tabId: string, data: string, readPrompt?: () => string): void;
}

const STYLED_CLASSES = styledPrimitiveClasses();
const id = (testId: string) => `[data-testid="${testId}"]`;
const DIALOG = id("recording-save-dialog");
const EDITOR = id("automation-editor-dialog");

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
}

/** Open the app with a library and one connected terminal. */
async function boot(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__VISUAL_SCENARIO__ = { populated: true, terminal: true };
  });
  await page.goto("/tests/visual/harness/index.html");
  await page.waitForFunction(() => window.__visual !== undefined);
  await page.locator("[data-testid=sidebar]").waitFor();
  await page.evaluate(() => {
    const state = window.__visual.store.getState() as unknown as {
      loadAutomations(): Promise<void>;
    };
    return state.loadAutomations();
  });
  if ((await page.locator(".xterm").count()) === 0) {
    await page.locator(id("terminal-view-new-terminal")).click();
  }
  await page.locator(".xterm").first().waitFor();
}

/** Start recording the active terminal from the toolbar. */
async function startRecording(page: Page): Promise<void> {
  await expect(async () => {
    if ((await page.locator(id("terminal-view-record")).count()) === 0) {
      await page.locator(id("terminal-view-more-actions")).click();
    }
    await page.locator(id("terminal-view-record")).click({ timeout: 1000 });
    await page.locator(id("terminal-view-active-recording")).waitFor({ timeout: 1000 });
  }).toPass();
}

/** Record `keys` in the recorded terminal, each typed after `prompt`. */
async function type(page: Page, keys: string[], prompt = "$ "): Promise<void> {
  await page.evaluate(
    ([typed, before]) => {
      const state = () => window.__visual.store.getState() as unknown as RecordingState;
      const tabId = state().recording!.tabId;
      for (const key of typed as string[]) {
        state().recordInput(tabId, key, () => before as string);
      }
    },
    [keys, prompt] as const
  );
}

const stop = (page: Page) => page.locator(id("terminal-view-active-recording")).click();

for (const viewport of [
  { width: 800, height: 600 },
  { width: 1280, height: 800 },
]) {
  const size = `${viewport.width}x${viewport.height}`;

  test.describe(`recording at ${size}`, () => {
    test.use({ viewport });

    async function shot(page: Page, name: string): Promise<void> {
      await settle(page);
      const path = join(SCREENS, "recording", `${name}-${size}.png`);
      await page.screenshot({ path });
      await test.info().attach(`${name} (${size})`, { path, contentType: "image/png" });
    }

    /** Audit `root`, check that it fits the window, and screenshot it. */
    async function check(page: Page, name: string, root: string): Promise<void> {
      await shot(page, name);
      const issues = await page.evaluate(auditLayout, { root, styledClasses: STYLED_CLASSES });
      expect.soft(issues, name).toEqual([]);
      const box = (await page.locator(root).boundingBox())!;
      expect.soft(box.x).toBeGreaterThanOrEqual(0);
      expect.soft(box.y).toBeGreaterThanOrEqual(0);
      expect.soft(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect.soft(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    }

    test("shows on the toolbar and the tab, and saves in one step", async ({ page }) => {
      await boot(page);
      await startRecording(page);
      await type(page, ["git pull", "\r"]);
      const badge = page.locator("[data-testid^=tab-recording-badge-]");
      await expect(badge).toBeVisible();
      await expect(page.locator(id("terminal-view-active-recording"))).toHaveText("Stop recording");
      await check(page, "chip", id("terminal-view-active-recording"));
      await stop(page);
      await page.locator(DIALOG).waitFor();
      await expect(page.locator(id("recording-save-name"))).toHaveValue("git pull");
      await expect(page.locator(id("recording-save-name"))).toBeFocused();
      await check(page, "save", DIALOG);
      await page.locator(id("recording-save-details")).click();
      await page.locator(id("recording-save-tags")).waitFor();
      await check(page, "save-details", DIALOG);
      await page.locator(id("recording-save-to-existing")).click();
      await check(page, "save-existing", DIALOG);
    });

    test("announces a password prompt and leaves it out", async ({ page }) => {
      await boot(page);
      await startRecording(page);
      await type(page, ["sudo -v\r"]);
      await type(page, ["h", "u", "n"], "[sudo] password for arne: ");
      await expect(page.locator(id("terminal-view-active-recording"))).toHaveText("Stop recording");
      await expect(page.locator(id("recording-bar-prompt"))).toContainText(
        "is kept out of the recording"
      );
      await check(page, "prompt", id("recording-bar-prompt"));
      await type(page, ["\r"], "[sudo] password for arne: ");
      await stop(page);
      await page.locator(id("recording-save-secrets")).waitFor();
      await check(page, "save-secrets", DIALOG);
    });

    test("keeps the recording in a bar when the dialog is closed", async ({ page }) => {
      await boot(page);
      await startRecording(page);
      await type(page, ["ls\r"]);
      await stop(page);
      await page.locator(DIALOG).waitFor();
      await page.keyboard.press("Escape");
      await page.locator(DIALOG).waitFor({ state: "detached" });
      await check(page, "kept", id("recording-bar-unsaved"));
      await page.locator(id("recording-bar-save")).click();
      await page.locator(DIALOG).waitFor();
    });

    test("records steps into the open editor and comes back", async ({ page }) => {
      await boot(page);
      await page.evaluate(() => {
        const state = window.__visual.store.getState() as unknown as {
          sidebarView: string;
          setSidebarView(view: string): void;
        };
        if (state.sidebarView !== "automations") state.setSidebarView("automations");
      });
      await page.locator(id("automation-item-wf-4")).hover();
      await page.locator(id("automation-edit-wf-4")).click();
      await page.locator(EDITOR).waitFor();
      await check(page, "editor", EDITOR);
      await page.locator(id("automation-editor-record")).click();
      const item = page.locator("[data-testid^=automation-editor-record-in-]").first();
      if (await item.isVisible()) {
        await shot(page, "editor-terminals");
        await item.click();
      }
      await page.locator(id("recording-bar-editor")).waitFor();
      await expect(page.locator(EDITOR)).toHaveCount(0);
      await type(page, ["systemctl restart web", "\r"]);
      await check(page, "editor-bar", id("recording-bar-editor"));
      await page.locator(id("recording-bar-return")).click();
      await page.locator(EDITOR).waitFor();
      await expect(page.locator(id("automation-editor-recorded"))).toBeVisible();
      await check(page, "editor-returned", EDITOR);
    });
  });
}
