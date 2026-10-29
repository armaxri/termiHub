/**
 * #5068 phase 1: the shared connect-progress prototype, rendered by the real
 * `ConnectProgress` component in a dev-only gallery (harness/connect-progress.html,
 * not wired into the app). For Dark and Light it checks every cell renders
 * without overflowing its panel, then screenshots the gallery for the design
 * review. The suite runs with reduced motion, so the ring shows its
 * `--cp-progress` fallback fill and no comet — a deterministic frame.
 */

import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { SCREENS } from "./surfaces";

const THEMES = ["dark", "light"] as const;

test.use({ viewport: { width: 1200, height: 1800 } });

test("the connect-progress prototype renders every phase in Dark and Light", async ({
  page,
}, testInfo) => {
  for (const theme of THEMES) {
    await page.goto(`/tests/visual/harness/connect-progress.html?theme=${theme}`);
    const gallery = page.locator("[data-testid=connect-progress-gallery]");
    await gallery.waitFor();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));

    const cells = page.locator("[data-testid=connect-progress-cell]");
    await expect(cells, `${theme}: one panel per phase`).toHaveCount(8);

    const overflowing = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>(".ui-content-overlay"))
        .filter(
          (el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1
        )
        .map((el) => el.closest("figure")?.querySelector("figcaption")?.textContent ?? "?")
    );
    expect(overflowing, `${theme}: no panel content overflows`).toEqual([]);

    // The ring fill sits at the elapsed fraction (4s of 90s for the Telnet cell).
    const offset = await page
      .locator(".ui-connect-progress__ring-fill")
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).strokeDashoffset));
    expect(offset).toBeCloseTo(175.929 * (1 - 4 / 90), 0);

    const file = join(SCREENS, "connect-progress", `gallery-${theme}.png`);
    await gallery.screenshot({ path: file });
    await testInfo.attach(`connect-progress gallery (${theme})`, {
      path: file,
      contentType: "image/png",
    });
  }
});
