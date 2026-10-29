/**
 * The terminal grid fits the visible pane (#5065).
 *
 * A full-screen program (Claude Code) lays out every row to the PTY width. When
 * xterm's grid is wider than the columns the pane shows, the right-most columns
 * are cut off. These checks run the real frontend in Chromium (the WebView2
 * engine) against the IPC mock and compare, after each layout change:
 *
 * - xterm's grid against the columns visible between the grid's left edge and
 *   the right edge of everything that clips it;
 * - the last PTY resize the app sent against the grid.
 *
 * The device-pixel-ratio change (monitor move, display scale) is the case that
 * leaves the container's CSS size alone: only the WebGL cell width changes, so
 * nothing but an explicit re-fit keeps the grid inside the pane.
 * The PTY side under real shells (ConPTY included) is graded by
 * tests/system/tests/test_tui_width_grades.py.
 */

import { expect, test, type Page } from "@playwright/test";

import type { VisualScenario } from "./harness/mockBackend";

/** One terminal's fit, as the checks read it. */
interface FitReading {
  renderer: string | undefined;
  cols: number;
  rows: number;
  cellWidth: number;
  visibleCols: number;
  dpr: number;
  lastResize: { cols: number; rows: number } | null;
}

async function boot(page: Page, scenario: VisualScenario): Promise<void> {
  await page.addInitScript((s) => {
    window.__VISUAL_SCENARIO__ = s;
  }, scenario);
  await page.goto("/tests/visual/harness/index.html");
  await page.waitForFunction(() => window.__visual !== undefined);
  await page.locator("[data-testid=sidebar]").waitFor();
}

/** Open a local terminal tab and wait for its session; returns the tab id. */
async function openTerminal(page: Page, fontSize?: number): Promise<string> {
  const tabId = await page.evaluate(
    (size) =>
      window.__visual.store
        .getState()
        .addTab(
          "Fit",
          "local",
          { type: "local", config: {} },
          { contentType: "terminal", terminalOptions: size ? { fontSize: size } : undefined }
        ) as string,
    fontSize
  );
  await page.waitForFunction(() => (window.__VISUAL_RESIZES__ ?? []).length > 0);
  return tabId;
}

/** Read the terminal's grid, its visible columns and the last PTY resize. */
function readFit(page: Page, tabId: string): Promise<FitReading> {
  return page.evaluate((id) => {
    interface XtermLike {
      cols: number;
      rows: number;
      _core: { _renderService: { dimensions: { css: { cell: { width: number } } } } };
    }
    const el = document.querySelector<HTMLElement>(`[data-testid="terminal-renderer-${id}"]`);
    const xterm = (el as (HTMLElement & { _xtermInstance?: XtermLike }) | null)?._xtermInstance;
    const screen = el?.querySelector<HTMLElement>(".xterm-screen");
    if (!el || !xterm || !screen) throw new Error(`terminal ${id} is not mounted`);
    let right = window.innerWidth;
    for (let node = screen.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.overflowX === "visible" && style.overflowY === "visible") continue;
      const rect = node.getBoundingClientRect();
      right = Math.min(right, rect.left + node.clientLeft + node.clientWidth);
    }
    const cellWidth = xterm._core._renderService.dimensions.css.cell.width;
    const left = screen.getBoundingClientRect().left;
    const resizes = (window.__VISUAL_RESIZES__ ?? []).filter((r) => r.sessionId !== "");
    const last = resizes[resizes.length - 1];
    return {
      renderer: el.dataset.terminalRenderer,
      cols: xterm.cols,
      rows: xterm.rows,
      cellWidth,
      visibleCols: Math.floor((right - left + 0.5) / cellWidth),
      dpr: window.devicePixelRatio,
      lastResize: last ? { cols: last.cols, rows: last.rows } : null,
    };
  }, tabId);
}

/** Wait until the grid fits the pane and the PTY was sent exactly that grid. */
async function expectFits(page: Page, tabId: string, when: string): Promise<FitReading> {
  let last: FitReading | null = null;
  await expect
    .poll(
      async () => {
        last = await readFit(page, tabId);
        return (
          last.cols <= last.visibleCols &&
          last.lastResize?.cols === last.cols &&
          last.lastResize?.rows === last.rows
        );
      },
      { message: `the grid to fit the pane ${when}`, timeout: 10_000 }
    )
    .toBe(true);
  return last as unknown as FitReading;
}

test("#5065: the grid fits the pane after open, split, zoom and window resizes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await boot(page, { terminal: true });
  const tabId = await openTerminal(page);
  const open = await expectFits(page, tabId, "on first open");

  await page.locator("[data-testid=terminal-view-split-horizontal]").first().click();
  const split = await expectFits(page, tabId, "after a split");
  expect(split.cols).toBeLessThan(open.cols);

  await page.setViewportSize({ width: 1013, height: 700 });
  await expectFits(page, tabId, "after shrinking the window");
  await page.setViewportSize({ width: 1400, height: 850 });
  await expectFits(page, tabId, "after growing the window");
});

test("#5065: the grid re-fits when the device pixel ratio changes", async ({ page, context }) => {
  const width = 1280;
  const height = 800;
  await page.setViewportSize({ width, height });
  await boot(page, { terminal: true });
  // 13px: the WebGL cell is 7px at 1x and 7.5px at 2x — a grid fitted at 1x
  // is five columns wider than the pane at 2x.
  const tabId = await openTerminal(page, 13);
  const base = await expectFits(page, tabId, "at 13px");
  test.skip(base.renderer !== "webgl", "the WebGL renderer is what floors the cell per ratio");

  const cdp = await context.newCDPSession(page);
  for (const dpr of [1.5, 2, 1.25, 1]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: dpr,
      mobile: false,
    });
    // The emulated ratio change fires no media-query change in headless
    // Chromium; the window resize event a real monitor move also brings does.
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    const fit = await expectFits(page, tabId, `at ${dpr}x`);
    expect(fit.dpr).toBe(dpr);
  }
});
