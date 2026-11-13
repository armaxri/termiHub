/**
 * Selected rows look the same in every selectable list (#5591), checked in the
 * rendered app: a selected file-browser row (sidebar) and a selected transfer
 * pane row (on the `--bg-secondary` pane) paint the shared `--selected-row-*`
 * surfaces and the 2px indicator bar, in Dark (accent tint, no bar) and both
 * Solarized themes (palette surface + bar). In Solarized Light the pane is
 * base2, so its rows step up to base3; sidebar rows use the theme's active
 * tone (#5639). Expected colours come from the theme definitions.
 *
 * Screenshots land in the usual screens/ folder for human review.
 */

import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import type { VisualScenario } from "./harness/mockBackend";
import type { VisualHandle } from "./harness/visualHandle";
import { SCREENS } from "./surfaces";
import { solarizedLightTheme } from "../../src/themes/solarized-light";

declare global {
  interface Window {
    __visual: VisualHandle;
  }
}

test.use({ viewport: { width: 1280, height: 800 } });

/** `#rrggbb` as the `rgb(r, g, b)` string getComputedStyle reports. */
function rgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

const SOL_LIGHT = solarizedLightTheme;

/** Per theme: the expected opaque surfaces, or `null` for the accent tint. */
const THEMES = [
  { theme: "dark", sidebar: null, pane: null, bar: null },
  {
    theme: "solarized-light",
    // #5639: the active tone on base3; base3 on the base2 pane.
    sidebar: { row: rgb(SOL_LIGHT.selection!.bg), under: rgb(SOL_LIGHT.colors.sidebarBg) },
    pane: {
      row: rgb(SOL_LIGHT.selection!.secondary!.bg),
      under: rgb(SOL_LIGHT.colors.bgSecondary),
    },
    bar: rgb(SOL_LIGHT.selection!.indicator), // accentColor
  },
  {
    theme: "solarized-dark",
    sidebar: { row: "rgb(0, 43, 54)", under: "rgb(7, 54, 66)" }, // base03 on base02
    pane: { row: "rgb(0, 43, 54)", under: "rgb(7, 54, 66)" }, // base03 on base02
    bar: "rgb(38, 139, 210)", // blue, canonical
  },
] as const;

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
}

/** What a selected row rendered, plus what the shared token resolves to on this page. */
async function measure(row: Locator, under: string, token: string) {
  return row.evaluate(
    (el, [surfaceSelector, cssVar]) => {
      const probe = document.createElement("div");
      probe.style.background = `var(${cssVar})`;
      document.body.appendChild(probe);
      const tokenBg = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const surface = el.closest(surfaceSelector);
      return {
        bg: getComputedStyle(el).backgroundColor,
        shadow: getComputedStyle(el).boxShadow,
        under: surface ? getComputedStyle(surface).backgroundColor : "",
        tokenBg,
      };
    },
    [under, token] as const
  );
}

function expectSelected(
  got: Awaited<ReturnType<typeof measure>>,
  surface: { row: string; under: string } | null,
  bar: string | null
): void {
  // Every list paints the shared token, whatever the theme.
  expect(got.bg).toBe(got.tokenBg);
  expect(got.shadow).toContain("inset");
  if (surface && bar) {
    expect(got.bg).toBe(surface.row);
    expect(got.under).toBe(surface.under);
    expect(got.shadow).toContain(bar);
  } else {
    // The accent tint: translucent, no bar.
    expect(got.bg).not.toBe(got.under);
    expect(got.shadow).toContain("rgba(0, 0, 0, 0)");
  }
}

for (const t of THEMES) {
  test(`a selected file-browser row uses the shared selection in ${t.theme} (#5591)`, async ({
    page,
  }, testInfo) => {
    // A live local terminal gives the file browser its local mode (#5591).
    const scenario: VisualScenario = { terminal: true, fileListing: true };
    await page.addInitScript((s) => {
      window.__VISUAL_SCENARIO__ = s;
    }, scenario);
    await page.goto("/tests/visual/harness/index.html");
    await page.waitForFunction(() => window.__visual !== undefined);
    await page.locator("[data-testid=sidebar]").waitFor();
    await page.evaluate((theme) => window.__visual.applyTheme(theme), t.theme);
    await page.evaluate(() => {
      window.__visual.store
        .getState()
        .addTab("Shell", "local", { type: "local", config: {} }, { contentType: "terminal" });
    });
    await page.evaluate(() => {
      const state = window.__visual.store.getState() as unknown as {
        sidebarView: string;
        sidebarCollapsed: boolean;
        setSidebarView(view: string): void;
      };
      if (state.sidebarView !== "files" || state.sidebarCollapsed) state.setSidebarView("files");
    });
    const button = page.locator("[data-testid='file-row-notes.md']");
    await button.waitFor();
    await button.click();
    const row = page.locator(".file-browser__row-wrapper--selected");
    await expect(row).toHaveCount(1);
    // Move the pointer away so the row shows its resting selected state.
    await page.mouse.move(800, 600);
    await settle(page);
    await page.waitForTimeout(200);

    expectSelected(
      await measure(row, "[data-testid=sidebar]", "--selected-row-bg"),
      t.sidebar,
      t.bar
    );

    const file = join(SCREENS, "selected-rows", `file-browser-${t.theme}.png`);
    await page.locator("[data-testid=sidebar]").screenshot({ path: file, animations: "disabled" });
    await testInfo.attach(`file browser (${t.theme})`, { path: file, contentType: "image/png" });
  });

  test(`a selected transfer-pane row uses the pane selection in ${t.theme} (#5591)`, async ({
    page,
  }, testInfo) => {
    await page.goto(`/tests/visual/harness/transfer-pane-paths.html?theme=${t.theme}`);
    const cell = page.locator("[data-testid=tpg-cell-short-local]");
    await cell.waitFor();
    await page.mouse.move(0, 0);
    await settle(page);
    const row = cell.locator(".transfer-pane__row--selected");
    await expect(row).toHaveCount(1);

    expectSelected(
      await measure(row, ".transfer-pane", "--selected-row-secondary-bg"),
      t.pane,
      t.bar
    );

    const file = join(SCREENS, "selected-rows", `transfer-pane-${t.theme}.png`);
    await cell.screenshot({ path: file, animations: "disabled" });
    await testInfo.attach(`transfer pane (${t.theme})`, { path: file, contentType: "image/png" });
  });
}
