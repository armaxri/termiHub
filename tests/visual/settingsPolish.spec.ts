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

test.describe("shared settings layout (#5843)", () => {
  test.use({ viewport: { width: 1600, height: 900 } });

  test("compact numbers, a plain Default marker and one centred page", async ({ page }) => {
    await boot(page);
    await openSettings(page, "appearance");
    const fontSize = page.locator("[data-testid=settings-font-size-input]");
    await fontSize.waitFor();
    const width = await fontSize.evaluate((el) => el.getBoundingClientRect().width);
    expect(width, "the font size input is compact").toBeLessThanOrEqual(140);
    await expect(page.locator("[data-testid=settings-font-size-unit]")).toHaveText("px");

    const tag = page.locator("[data-testid=settings-font-size-default]");
    const tagStyle = await tag.evaluate((el) => {
      const s = getComputedStyle(el);
      return { border: s.borderTopWidth, background: s.backgroundColor };
    });
    expect(tagStyle.border, "the Default marker has no border").toBe("0px");
    expect(tagStyle.background, "the Default marker has no fill").toBe("rgba(0, 0, 0, 0)");

    const frame = await page.evaluate((selector) => {
      const panel = document.querySelector(selector)!;
      const box = (el: Element | null) => el!.getBoundingClientRect();
      return {
        panel: box(panel),
        search: box(panel.querySelector(".settings-search")),
        body: box(panel.querySelector(".settings-panel__body")),
      };
    }, SETTINGS_PANEL);
    for (const name of ["search", "body"] as const) {
      const r = frame[name];
      const left = r.left - frame.panel.left;
      const right = frame.panel.right - r.right;
      expect(Math.abs(left - right), `${name} is centred`).toBeLessThanOrEqual(2);
      expect(r.width, `${name} is capped`).toBeLessThanOrEqual(822);
    }
    await page.screenshot({ path: join(SCREENS, "settings-polish", "layout-appearance.png") });

    await openSettings(page, "sessions");
    const clear = page.locator("[data-testid=settings-clear-network-tool-history]");
    await expect(clear).toHaveClass(/ui-btn--secondary/);
    const hint = page.locator("[data-testid=settings-network-tool-history-hint]");
    const lines = await hint.evaluate(
      (el) => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)
    );
    expect(lines, "the network tool history hint is one line").toBeLessThanOrEqual(1.5);
    await page.screenshot({ path: join(SCREENS, "settings-polish", "layout-sessions.png") });
  });
});
