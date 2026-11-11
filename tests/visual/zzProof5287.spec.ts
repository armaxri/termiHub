// TEMPORARY #5287 CI proof: the settled-reading spec, 50 times. Removed before merge.
import { expect, test } from "@playwright/test";

test.use({ launchOptions: { args: ["--disable-webgl", "--disable-webgl2"] } });

for (let i = 0; i < 50; i++)
  test(`#5287 proof ${i}: DOM-rendered rows keep their text inside the grid`, async ({ page }) => {
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
        options: { letterSpacing: number; fontFamily?: string; fontSize?: number };
        write(data: string, done: () => void): void;
        _core: { _renderService: { dimensions: { css: { cell: { width: number } } } } };
      }
      const el = document.querySelector<HTMLElement>(sel);
      const xterm = (el as (HTMLElement & { _xtermInstance?: XtermLike }) | null)?._xtermInstance;
      if (!el || !xterm) throw new Error("terminal not mounted");
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      const cellWidth = () => xterm._core._renderService.dimensions.css.cell.width;
      const grid = () => `${xterm.cols}x${cellWidth()}`;
      // Wait until the grid holds still for a few frames (or give up after ~2s;
      // the reading below then still has to come out stable on its own).
      const settle = async () => {
        let last = grid();
        for (let quiet = 0, n = 0; quiet < 5 && n < 120; n++) {
          await frame();
          const now = grid();
          quiet = now === last ? quiet + 1 : 0;
          last = now;
        }
      };
      // The terminal web font usually loads after the terminal opened. When it
      // lands, the app re-measures the cell and re-fits the grid (#5082), and the
      // DOM glyphs swap fonts under rows rendered for the fallback. A reading
      // taken in that window measures a half-switched terminal (#5287), so let
      // the font and the re-fit it causes finish first.
      await document.fonts.ready;
      await settle();
      xterm.options.letterSpacing = -1;
      await settle();
      const read = () => {
        const screen = el.querySelector<HTMLElement>(".xterm-screen");
        const row = Array.from(el.querySelectorAll(".xterm-rows > div")).find((r) =>
          (r.textContent ?? "").endsWith("|")
        );
        if (!screen || !row) return undefined;
        const range = document.createRange();
        range.selectNodeContents(row);
        const rects = Array.from(range.getClientRects());
        const cell = cellWidth();
        return {
          textRight: Math.max(...rects.map((r) => r.right)),
          gridRight: screen.getBoundingClientRect().left + xterm.cols * cell,
          cell,
          cols: xterm.cols,
        };
      };
      // Write a ruler that spans the whole grid and read it once two
      // consecutive frames agree: a reading is only taken of a settled render.
      // A grid change after the write (a late re-fit) reflows the ruler, so
      // write it again for the new width.
      let last: ReturnType<typeof read>;
      for (let attempt = 0; attempt < 5; attempt++) {
        const cols = xterm.cols;
        const ruler = Array.from({ length: cols - 1 }, (_, i) => String((i + 1) % 10)).join("");
        await new Promise<void>((r) => xterm.write(`\r\n${ruler}|`, r));
        last = undefined;
        for (let n = 0; n < 60 && xterm.cols === cols; n++) {
          await frame();
          const now = read();
          if (now && JSON.stringify(now) === JSON.stringify(last)) {
            return now;
          }
          last = now;
        }
      }
      if (!last) throw new Error("ruler row not painted");
      return last;
    }, selector);

    // The ruler's last glyph ends on the grid's last cell, not past it.
    expect(reading.textRight).toBeLessThanOrEqual(reading.gridRight + 1);
    expect(reading.textRight).toBeGreaterThan(reading.gridRight - reading.cell);
  });
