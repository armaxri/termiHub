/**
 * A new terminal opens at the grid that fits its pane (#5082).
 *
 * xterm measures its character cell once, when it opens, and again only on a
 * font-option change, a resize or a pixel-ratio change. The terminal font is a
 * web font (`font-display: swap`) that has usually not loaded when a new tab
 * opens, so that first measurement can be the fallback font's. On a Retina Mac
 * the fallback (Menlo) cell is 16 CSS px tall and the real font's 18: a pane
 * fitted with the stale cell gets too many rows (the bottom is cut off) and,
 * with a fallback of another width, the wrong number of columns. Re-fitting
 * after the font loads changes nothing while xterm still holds the stale
 * measurement, so the tab stayed wrong until the next window resize.
 *
 * The check opens a tab with the font arriving late, waits for it, and then
 * compares the grid (and the size last sent to the PTY) with what the fit
 * proposes once xterm measures the loaded font — without any resize.
 */

import { expect, test } from "@playwright/test";

/** Delay for the terminal web font, so it lands after the tab has opened. */
const FONT_DELAY_MS = 600;

test.use({ deviceScaleFactor: 2, viewport: { width: 1280, height: 800 } });

test("#5082: a new tab's grid and PTY size fit the pane once the font has loaded", async ({
  page,
}) => {
  await page.route("**/fonts/**", async (route) => {
    await new Promise((r) => setTimeout(r, FONT_DELAY_MS));
    await route.continue();
  });
  await page.addInitScript(() => {
    window.__VISUAL_SCENARIO__ = { terminal: true };
  });
  await page.goto("/tests/visual/harness/index.html");
  await page.waitForFunction(() => window.__visual !== undefined);
  await page.locator("[data-testid=sidebar]").waitFor();
  const tabId = await page.evaluate(
    () =>
      window.__visual.store
        .getState()
        .addTab(
          "First",
          "local",
          { type: "local", config: {} },
          { contentType: "terminal" }
        ) as string
  );
  await page.waitForFunction(() => (window.__VISUAL_RESIZES__ ?? []).length > 0);
  // Wait for the regular face itself: `document.fonts.check()` already
  // answers true while it is still loading.
  await page.waitForFunction(
    () =>
      [...document.fonts].some(
        (face) =>
          face.family.includes("MesloLGS Nerd Font Mono") &&
          face.weight === "400" &&
          face.status === "loaded"
      ),
    undefined,
    { timeout: 30_000 }
  );
  // Let the app's own font-load handling run (a frame or two after the load,
  // plus the PTY resize it sends).
  await page.waitForTimeout(1000);

  /** Grid, last PTY size, and the fit proposal for the font as now loaded. */
  const read = () =>
    page.evaluate(async (id) => {
      interface FitLike {
        proposeDimensions(): { cols: number; rows: number } | undefined;
      }
      interface XtermLike {
        cols: number;
        rows: number;
        _core: { _charSizeService: { measure(): void } };
        _addonManager: { _addons: { instance: Partial<FitLike> }[] };
      }
      const el = document.querySelector(`[data-testid="terminal-renderer-${id}"]`);
      const xterm = (el as (Element & { _xtermInstance?: XtermLike }) | null)?._xtermInstance;
      if (!xterm) throw new Error("terminal not mounted");
      const grid = { cols: xterm.cols, rows: xterm.rows };
      const resizes = window.__VISUAL_RESIZES__ ?? [];
      const last = resizes[resizes.length - 1];
      // What a fit proposes once xterm has measured the loaded font. Measuring
      // here does not resize anything, so the grid read above is untouched.
      xterm._core._charSizeService.measure();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const fit = xterm._addonManager._addons
        .map((a) => a.instance)
        .find((a): a is FitLike => typeof a.proposeDimensions === "function");
      const proposed = fit?.proposeDimensions();
      return {
        grid,
        pty: last ? { cols: last.cols, rows: last.rows } : null,
        proposed: proposed ? { cols: proposed.cols, rows: proposed.rows } : null,
      };
    }, tabId);

  // One read: the grid and PTY size are captured before the measurement the
  // proposal needs, so the check cannot pass on a re-fit it triggered itself.
  const reading = await read();
  expect(reading.proposed).not.toBeNull();
  expect(reading.grid, "xterm's grid after the font loaded").toEqual(reading.proposed);
  expect(reading.pty, "the size last sent to the PTY").toEqual(reading.proposed);
});
