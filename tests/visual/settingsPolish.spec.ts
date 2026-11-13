/**
 * Settings polish from the product-run UI review (#5561), checked in the
 * rendered app at 1280×800:
 *
 * - the grouped category nav fits without scrolling, with Advanced folded;
 * - no build-info footer under the settings content;
 * - field labels are not uppercased by CSS;
 * - Appearance shows no disabled theme actions and an empty Font family;
 * - the Keyboard table offers no reset on rows that are at their default.
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
const NAV = `${SETTINGS_PANEL} .settings-nav`;

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

async function openSettings(page: Page, category?: string): Promise<void> {
  await page.evaluate((cat) => {
    void window.__visual.store.getState().openSettingsTab(cat ? { category: cat } : undefined);
  }, category);
  await page.locator(SETTINGS_PANEL).waitFor();
  await expect(page.locator(".settings-panel__lazy-fallback")).toHaveCount(0);
  await settle(page);
}

test("the grouped settings nav fits 1280x800 with Advanced folded (#5561)", async ({ page }) => {
  await boot(page);
  await openSettings(page);
  const nav = page.locator(NAV);
  await nav.waitFor();
  const fit = await nav.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  expect(fit.scrollHeight, "the folded nav needs no scrolling").toBeLessThanOrEqual(
    fit.clientHeight
  );
  await expect(page.locator("[data-testid=settings-navgroup-advanced-toggle]")).toBeVisible();
  await expect(page.locator("[data-testid=settings-nav-portable]")).toBeHidden();
  await expect(page.locator("[data-testid=settings-nav-updates]")).toBeVisible();
  await expect(page.locator(`${SETTINGS_PANEL} .settings-panel__footer`)).toHaveCount(0);
  await page.screenshot({ path: join(SCREENS, "settings-polish", "nav-folded.png") });

  await page.locator("[data-testid=settings-navgroup-advanced-toggle]").click();
  await expect(page.locator("[data-testid=settings-nav-portable]")).toBeVisible();
  await page.locator("[data-testid=settings-nav-portable]").click();
  await expect(page.locator("[data-testid=settings-nav-portable]")).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await page.screenshot({ path: join(SCREENS, "settings-polish", "nav-advanced-open.png") });
});

test("settings field labels are sentence case, not uppercased (#5561)", async ({ page }) => {
  await boot(page);
  for (const category of ["general", "terminal", "appearance"]) {
    await openSettings(page, category);
    const transforms = await page
      .locator(`${SETTINGS_PANEL} .settings-form__label`)
      .evaluateAll((labels) => labels.map((l) => getComputedStyle(l).textTransform));
    expect(transforms.length, `${category} has field labels`).toBeGreaterThan(0);
    expect(
      transforms.filter((t) => t === "uppercase"),
      category
    ).toEqual([]);
  }
  await openSettings(page, "general");
  await page.screenshot({ path: join(SCREENS, "settings-polish", "general.png") });
});

test("appearance shows no disabled theme actions and an empty font family (#5561)", async ({
  page,
}) => {
  await boot(page);
  await openSettings(page, "appearance");
  const actions = page.locator(`${SETTINGS_PANEL} .appearance-settings__theme-actions button`);
  await expect(actions).toHaveCount(2);
  expect(
    await actions.evaluateAll((buttons) =>
      buttons.filter((b) => (b as HTMLButtonElement).disabled).map((b) => b.textContent)
    )
  ).toEqual([]);
  const font = page.locator("[data-testid=settings-font-family-input]");
  await expect(font).toHaveValue("");
  await expect(font).toHaveAttribute("placeholder", "Default font chain");
  const overflow = await font.evaluate(
    (el) => (el as HTMLInputElement).scrollWidth > (el as HTMLInputElement).clientWidth
  );
  expect(overflow, "the placeholder fits the input").toBe(false);
  await page.screenshot({ path: join(SCREENS, "settings-polish", "appearance.png") });
});

test("the keyboard table shows no reset on default rows (#5561)", async ({ page }) => {
  await boot(page);
  await openSettings(page, "keyboard");
  await page.locator("[data-testid=keybinding-row-toggle-sidebar]").waitFor();
  await expect(page.locator(`${SETTINGS_PANEL} [data-testid^=keybinding-reset-]`)).toHaveCount(0);
  await page.screenshot({ path: join(SCREENS, "settings-polish", "keyboard.png") });
});
