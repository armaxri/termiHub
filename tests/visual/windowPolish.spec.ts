/**
 * Main window and Solarized polish from the product-run UI review (#5559,
 * #5562), checked in the rendered app:
 *
 * - every Settings page shares one content-column width in every theme, with
 *   the scrollbar gutter reserved (the Appearance column was 13px wider in one
 *   capture than in another);
 * - the window toolbar shows three groups split by visible separators;
 * - a selected connection row in Solarized Light is base2 with an accent bar.
 *
 * Screenshots land in the usual screens/ folder for human review.
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

const SETTINGS_PANEL = ".settings-panel:not(.settings-panel--hidden)";
const CONTENT = `${SETTINGS_PANEL} .settings-panel__content`;
const THEMES = ["dark", "solarized-light"] as const;

test.use({ viewport: { width: 1280, height: 800 } });

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
}

async function boot(page: Page): Promise<void> {
  await page.goto("/tests/visual/harness/index.html");
  await page.waitForFunction(() => window.__visual !== undefined);
  await page.locator("[data-testid=sidebar]").waitFor();
  await settle(page);
}

async function store(page: Page, action: string, ...args: unknown[]): Promise<void> {
  await page.evaluate(
    ([name, rest]) => {
      void window.__visual.store.getState()[name as string](...(rest as unknown[]));
    },
    [action, args] as const
  );
}

async function openSettings(page: Page, category: string): Promise<void> {
  await store(page, "openSettingsTab", { category });
  await page.locator(SETTINGS_PANEL).waitFor();
  await expect(page.locator(".settings-panel__lazy-fallback")).toHaveCount(0);
  await settle(page);
}

test("settings pages share one content column width in every theme (#5562)", async ({
  page,
}, testInfo) => {
  await boot(page);
  await store(page, "openSettingsTab");
  const nav = page.locator(".settings-nav [data-testid^=settings-nav-]");
  await nav.first().waitFor();
  const categories = (
    await nav.evaluateAll((items) => items.map((item) => item.getAttribute("data-testid") ?? ""))
  ).map((id) => id.replace("settings-nav-", ""));
  expect(categories.length).toBeGreaterThan(10);

  const widths: Record<string, number> = {};
  for (const theme of THEMES) {
    await page.evaluate((t) => window.__visual.applyTheme(t), theme);
    for (const category of categories) {
      await openSettings(page, category);
      const { clientWidth, gutter } = await page.locator(CONTENT).evaluate((el) => ({
        clientWidth: el.clientWidth,
        gutter: getComputedStyle(el).scrollbarGutter,
      }));
      expect(gutter, `${theme}/${category} reserves the scrollbar gutter`).toContain("stable");
      widths[`${theme}/${category}`] = clientWidth;
    }
    await openSettings(page, "appearance");
    const file = join(SCREENS, "window-polish", `settings-appearance-${theme}.png`);
    await page.locator(SETTINGS_PANEL).screenshot({ path: file, animations: "disabled" });
    await testInfo.attach(`appearance (${theme})`, { path: file, contentType: "image/png" });
  }
  const distinct = [...new Set(Object.values(widths))];
  expect(distinct, `column widths per page/theme: ${JSON.stringify(widths)}`).toHaveLength(1);
});

test("the window toolbar shows session, macro and layout groups (#5559)", async ({
  page,
}, testInfo) => {
  await boot(page);
  const actions = page.locator(".terminal-view__toolbar-actions");
  await actions.waitFor();
  const layout = await actions.evaluate((root) =>
    Array.from(root.children).map((el) => {
      const r = el.getBoundingClientRect();
      return {
        kind: el.getAttribute("role") === "separator" ? "|" : el.getAttribute("aria-label"),
        left: r.left,
        right: r.right,
        width: r.width,
        height: r.height,
      };
    })
  );
  expect(layout.map((l) => l.kind)).toEqual(["Session", "|", "Macros", "|", "Layout"]);
  for (let i = 1; i < layout.length; i++) {
    expect(layout[i].left, `${layout[i].kind} starts after its neighbour`).toBeGreaterThanOrEqual(
      layout[i - 1].right
    );
  }
  for (const sep of layout.filter((l) => l.kind === "|")) {
    expect(sep.width).toBeGreaterThan(0);
    expect(sep.height).toBeGreaterThan(8);
  }
  const file = join(SCREENS, "window-polish", "toolbar.png");
  await actions.screenshot({ path: file, animations: "disabled" });
  await testInfo.attach("toolbar", { path: file, contentType: "image/png" });
});

test("a selected Solarized Light connection row is base2 with an accent bar (#5562)", async ({
  page,
}, testInfo) => {
  await boot(page);
  await page.evaluate(() => window.__visual.applyTheme("solarized-light"));
  const row = page.locator(".connection-tree__item").first();
  await row.waitFor();
  await row.click();
  await expect(row).toHaveClass(/connection-tree__item--selected/);
  // Move the pointer away so the row shows its resting selected state.
  await page.mouse.move(0, 0);
  await settle(page);
  await page.waitForTimeout(200);
  const { bg, shadow, sidebar } = await row.evaluate((el) => ({
    bg: getComputedStyle(el).backgroundColor,
    shadow: getComputedStyle(el).boxShadow,
    sidebar: getComputedStyle(el.closest("[data-testid=sidebar]")!).backgroundColor,
  }));
  expect(bg).toBe("rgb(238, 232, 213)"); // base2
  expect(sidebar).toBe("rgb(253, 246, 227)"); // base3
  expect(shadow).toContain("rgb(31, 111, 166)"); // accent bar
  expect(shadow).toContain("inset");
  const file = join(SCREENS, "window-polish", "solarized-light-selected-row.png");
  await page.locator("[data-testid=sidebar]").screenshot({ path: file, animations: "disabled" });
  await testInfo.attach("selected row (solarized light)", { path: file, contentType: "image/png" });
});
