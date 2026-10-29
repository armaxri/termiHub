/**
 * The DOM renderer's text stays inside its cells (#5065).
 *
 * Without WebGL (a VM or remote session that blocklists it, a lost GPU
 * context, more on-screen terminals than WebGL contexts) xterm paints rows as
 * DOM text. Each row is clipped at the grid's right edge, and xterm puts a
 * `letter-spacing` correction on the rows container so glyphs that are wider
 * or narrower than its measured cell still land on their cells. If the app's
 * CSS stops the spans from inheriting that correction, text wider than its
 * cells runs past the row's edge and the right-most characters are cut off.
 *
 * A letter-spacing of -1px gives a deterministic mismatch: cells one pixel
 * narrower than the glyphs, which only xterm's correction brings back in line.
 */

import { expect, test } from "@playwright/test";

test.use({ launchOptions: { args: ["--disable-webgl", "--disable-webgl2"] } });

test("#5065: DOM-rendered rows keep their text inside the grid", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
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
          "Dom",
          "local",
          { type: "local", config: {} },
          { contentType: "terminal" }
        ) as string
  );
  const selector = `[data-testid="terminal-renderer-${tabId}"]`;
  await expect(page.locator(selector)).toHaveAttribute("data-terminal-renderer", "dom");

  const reading = await page.evaluate(async (sel) => {
    interface XtermLike {
      cols: number;
      options: { letterSpacing: number };
      write(data: string, done: () => void): void;
      _core: { _renderService: { dimensions: { css: { cell: { width: number } } } } };
    }
    const el = document.querySelector<HTMLElement>(sel);
    const xterm = (el as (HTMLElement & { _xtermInstance?: XtermLike }) | null)?._xtermInstance;
    if (!el || !xterm) throw new Error("terminal not mounted");
    xterm.options.letterSpacing = -1;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const ruler = Array.from({ length: xterm.cols - 1 }, (_, i) => String((i + 1) % 10)).join("");
    await new Promise<void>((r) => xterm.write(`\r\n${ruler}|`, r));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const screen = el.querySelector<HTMLElement>(".xterm-screen");
    const row = Array.from(el.querySelectorAll(".xterm-rows > div")).find((r) =>
      (r.textContent ?? "").endsWith("|")
    );
    if (!screen || !row) throw new Error("ruler row not painted");
    const range = document.createRange();
    range.selectNodeContents(row);
    const rects = Array.from(range.getClientRects());
    const cell = xterm._core._renderService.dimensions.css.cell.width;
    return {
      textRight: Math.max(...rects.map((r) => r.right)),
      gridRight: screen.getBoundingClientRect().left + xterm.cols * cell,
      cell,
    };
  }, selector);

  // The ruler's last glyph ends on the grid's last cell, not past it.
  expect(reading.textRight).toBeLessThanOrEqual(reading.gridRight + 1);
  expect(reading.textRight).toBeGreaterThan(reading.gridRight - reading.cell);
});
