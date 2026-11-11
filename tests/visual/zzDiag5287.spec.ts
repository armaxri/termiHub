// TEMPORARY diagnostics for #5287 — removed before merge.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect, test } from "@playwright/test";

test.use({ launchOptions: { args: ["--disable-webgl", "--disable-webgl2"] } });

for (let i = 0; i < 25; i++)
  test(`diag5287 #${i}`, async ({ page }) => {
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
    const r = await page.evaluate(async (sel) => {
      const el = document.querySelector<HTMLElement>(sel) as any;
      const xterm = el._xtermInstance;
      const rs = xterm._core._renderService;
      const snap = (tag: string) => {
        const ren = rs._renderer?.value;
        return {
          tag,
          t: Math.round(performance.now()),
          cols: xterm.cols,
          char: xterm._core._charSizeService.width,
          cell: rs.dimensions.css.cell.width,
          ls: (el.querySelector(".xterm-rows") as HTMLElement | null)?.style.letterSpacing,
          defSp: ren?._rowFactory?.defaultSpacing,
          W: ren?._widthCache?.get?.("W", false, false),
          d1: ren?._widthCache?.get?.("1", false, false),
          paused: rs._isPaused,
          meslo: document.fonts.check('14px "MesloLGS Nerd Font Mono"'),
          fstat: document.fonts.status,
        };
      };
      const tl: any[] = [snap("start")];
      xterm.onResize((e: any) => tl.push({ ...snap("onResize"), to: e.cols }));
      xterm.options.letterSpacing = -1;
      tl.push(snap("set"));
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      tl.push(snap("raf"));
      const ruler = Array.from({ length: xterm.cols - 1 }, (_, i) => String((i + 1) % 10)).join("");
      await new Promise<void>((res) => xterm.write(`\r\n${ruler}|`, res));
      tl.push(snap("written"));
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      tl.push(snap("read"));
      const screen = el.querySelector(".xterm-screen") as HTMLElement;
      const row = Array.from(el.querySelectorAll(".xterm-rows > div")).find((x: any) =>
        (x.textContent ?? "").endsWith("|")
      ) as HTMLElement | undefined;
      let textRight = -1;
      let spans: any[] = [];
      if (row) {
        const range = document.createRange();
        range.selectNodeContents(row);
        textRight = Math.max(...Array.from(range.getClientRects()).map((x) => x.right));
        spans = Array.from(row.querySelectorAll("span")).map((s: any) => [
          s.textContent.length,
          s.style.letterSpacing,
          getComputedStyle(s).letterSpacing,
          getComputedStyle(s).fontFamily.slice(0, 20),
          s.getBoundingClientRect().width,
        ]);
      }
      // A fresh DOM measure of W in the terminal font, next to xterm's cache.
      const probe = document.createElement("span");
      probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font-kerning:none;font-family:${xterm.options.fontFamily};font-size:${xterm.options.fontSize}px`;
      probe.textContent = "W".repeat(32);
      el.querySelector(".xterm-helpers")!.appendChild(probe);
      const freshW = probe.getBoundingClientRect().width / 32;
      probe.remove();
      const containers = Array.from(el.querySelectorAll(".xterm-rows")).map((c: any) => ({
        ls: c.style.letterSpacing,
        hasRow: row ? c.contains(row) : false,
        parentIsScreen: c.parentElement === screen,
        rows: c.children.length,
      }));
      const xterms = el.querySelectorAll(".xterm").length;
      const screens = el.querySelectorAll(".xterm-screen").length;
      const ren = rs._renderer?.value;
      const liveIsRow = row ? ren?._rowContainer?.contains(row) : null;
      const liveLs = ren?._rowContainer?.style.letterSpacing;
      const rowParentLs = row ? (row.parentElement as HTMLElement).style.letterSpacing : null;
      const rowCs = row ? getComputedStyle(row).letterSpacing : null;
      const left = screen.getBoundingClientRect().left;
      const cell = rs.dimensions.css.cell.width;
      const gridRight = left + xterm.cols * cell;
      await new Promise((res) => setTimeout(res, 1500));
      tl.push(snap("late"));
      if (row) {
        const range2 = document.createRange();
        range2.selectNodeContents(row);
        tl.push({
          lateRight: Math.max(...Array.from(range2.getClientRects()).map((x) => x.right)),
          lateGrid: left + xterm.cols * rs.dimensions.css.cell.width,
          lateRowCs: getComputedStyle(row).letterSpacing,
          lateConnected: row.isConnected,
          lateParentLs: (row.parentElement as HTMLElement | null)?.style.letterSpacing,
        });
      }
      return {
        ok: row !== undefined && textRight <= gridRight + 1 && textRight > gridRight - cell,
        textRight,
        gridRight,
        left,
        rowLen: row?.textContent?.length,
        rulerLen: ruler.length + 1,
        freshW,
        containers,
        xterms,
        screens,
        liveIsRow,
        liveLs,
        rowParentLs,
        rowCs,
        spans,
        dpr: window.devicePixelRatio,
        tl,
      };
    }, selector);
    console.log(`DIAG5287 ${r.ok ? "OK" : "BAD"} ${JSON.stringify(r)}`);
  });
