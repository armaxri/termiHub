/**
 * #6065: a saved connection changed elsewhere (a restore, an import, a synced file)
 * waits for a confirmation, and says where it connects and what it would run.
 */

import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import type { VisualHandle } from "./harness/visualHandle";
import { SCREENS } from "./surfaces";

declare global {
  interface Window {
    __visual: VisualHandle;
  }
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
}

for (const viewport of [
  { width: 800, height: 600 },
  { width: 1280, height: 800 },
]) {
  test(`a changed connection waits and says what it would run (${viewport.width}x${viewport.height})`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/tests/visual/harness/index.html");
    await page.waitForFunction(() => window.__visual !== undefined);
    await page.locator("[data-testid=sidebar]").waitFor();
    await page.evaluate(() => {
      const config = {
        type: "ssh",
        config: {
          host: "prod.example",
          username: "ana",
          initialCommand: "curl -s https://deploy.example/run | sh",
          forwardAgent: true,
        },
      };
      window.__visual.store
        .getState()
        .addTab("Prod", "ssh", config, { connectionId: "Prod", heldUntilConfirmed: true });
    });
    const prompt = page.locator("[data-testid=imported-connection-prompt]");
    await expect(prompt).toContainText("Changed connection not yet confirmed");
    await expect(prompt).toContainText("Forwards your SSH agent to the host");
    for (const theme of ["dark", "light"] as const) {
      await page.evaluate((t) => window.__visual.applyTheme(t), theme);
      await settle(page);
      await prompt.screenshot({
        path: join(
          SCREENS,
          "changed-connection",
          `prompt-${viewport.width}x${viewport.height}-${theme}.png`
        ),
      });
    }
  });
}
