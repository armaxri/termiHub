/**
 * #5091: the toast close (x) button must stay visible in every built-in theme.
 * A toast is raised in the booted app; for each theme the close icon's computed
 * colour is asserted to reach 3:1 (WCAG 2.2 1.4.11) against the toast surface,
 * and the toast is screenshotted for the visual record.
 */

import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { contrastRatio } from "../../src/themes/contrast";
import type { VisualHandle } from "./harness/visualHandle";
import { SCREENS } from "./surfaces";

declare global {
  interface Window {
    __visual: VisualHandle;
  }
}

const THEMES = ["dark", "light", "solarized-dark", "solarized-light"] as const;

test.use({ viewport: { width: 1100, height: 720 } });

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
}

/** Resolve any CSS colour to `#rrggbb` through a canvas. */
async function toHex(page: Page, color: string): Promise<string> {
  return page.evaluate((c) => {
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.fillStyle = c;
    return ctx.fillStyle;
  }, color);
}

test("the toast close button reaches 3:1 contrast in every built-in theme", async ({
  page,
}, testInfo) => {
  await page.goto("/tests/visual/harness/index.html");
  await page.waitForFunction(() => window.__visual !== undefined);
  await page.locator("[data-testid=sidebar]").waitFor();
  await settle(page);

  await page.evaluate(async () => {
    const { toast } = await import("/src/components/ui/Toast/toast.ts");
    toast.error("Connection failed", { description: "Close button contrast sample" });
  });

  const toast = page.locator("[data-sonner-toast]").first();
  await expect(toast).toBeVisible();
  const close = toast.locator("[data-close-button]");
  await expect(close).toBeVisible();

  for (const theme of THEMES) {
    await page.evaluate((t) => window.__visual.applyTheme(t), theme);
    await settle(page);
    const { fg, bg } = await close.evaluate((el) => {
      const t = el.closest("[data-sonner-toast]") as HTMLElement;
      return {
        fg: getComputedStyle(el).color,
        bg: getComputedStyle(t).backgroundColor,
      };
    });
    const ratio = contrastRatio(await toHex(page, fg), await toHex(page, bg));
    expect(ratio, `${theme}: close icon ${fg} on toast ${bg}`).toBeGreaterThanOrEqual(3);

    const file = join(SCREENS, "toast-close-contrast", `toast-${theme}.png`);
    await toast.screenshot({ path: file, animations: "disabled" });
    await testInfo.attach(`toast close button (${theme})`, {
      path: file,
      contentType: "image/png",
    });
  }
});
