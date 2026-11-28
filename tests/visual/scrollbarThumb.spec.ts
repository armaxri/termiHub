/**
 * An overflowing scroller paints a thumb you can see (#6167, audit UI-016 b).
 *
 * The thumb is persistent (#3144), but a 0.45–0.5 alpha grey on a transparent
 * track measured under 2:1 against the panels it sits on, which reads as no
 * scrollbar. This renders a real overflowing box with the app's own scrollbar
 * CSS in Dark and Light, reads the painted pixels, and needs the thumb at 3:1
 * against the track beside it (WCAG 2.2 SC 1.4.11). The token values for all
 * four themes are graded without a browser in `src/themes/tokenContrast.test.ts`.
 */

import { expect, test, type Page } from "@playwright/test";

const THEMES = ["dark", "light"] as const;

// Headless Chromium hides scrollbars by default (Playwright passes
// --hide-scrollbars); this grade is about the painted bar, so show it.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

/** WCAG contrast of two RGB triples. */
function contrast(a: number[], b: number[]): number {
  const lum = (c: number[]) => {
    const [r, g, bl] = c.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [la, lb] = [lum(a), lum(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The RGB of the pixel at (x, y) of a PNG, decoded by the page's canvas. */
async function pixels(page: Page, png: Buffer, points: [number, number][]): Promise<number[][]> {
  return page.evaluate(
    async ({ data, points }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      return points.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3)));
    },
    { data: png.toString("base64"), points }
  );
}

for (const theme of THEMES) {
  test(`an overflowing scroller paints a visible thumb (${theme})`, async ({ page }) => {
    await page.goto(`/tests/visual/harness/connect-progress.html?theme=${theme}`);
    await page.locator("[data-testid=connect-progress-gallery]").waitFor();
    // A scroller on the main surface, three times as tall inside as out: the
    // thumb sits at the top third of the bar, the bare track below it.
    await page.evaluate(() => {
      const box = document.createElement("div");
      box.dataset.testid = "scroll-probe";
      Object.assign(box.style, {
        position: "fixed",
        top: "20px",
        left: "20px",
        width: "200px",
        height: "120px",
        overflow: "auto",
        background: "var(--bg-primary)",
        zIndex: "10",
      });
      const inner = document.createElement("div");
      inner.style.height = "360px";
      box.appendChild(inner);
      document.body.appendChild(box);
    });
    const probe = page.locator("[data-testid=scroll-probe]");
    const geometry = await probe.evaluate((el) => ({
      bar: el.offsetWidth - el.clientWidth,
      width: el.offsetWidth,
      height: el.offsetHeight,
    }));
    expect(geometry.bar, "the scroller has a classic scrollbar to paint").toBeGreaterThan(0);

    const scale = await page.evaluate(() => window.devicePixelRatio);
    const x = Math.floor((geometry.width - geometry.bar / 2) * scale);
    const thumbY = Math.floor(geometry.height * 0.15 * scale);
    const trackY = Math.floor(geometry.height * 0.85 * scale);
    const [thumb, track] = await pixels(page, await probe.screenshot(), [
      [x, thumbY],
      [x, trackY],
    ]);
    const ratio = contrast(thumb, track);
    expect(
      ratio,
      `${theme}: thumb rgb(${thumb}) on track rgb(${track}) is ${ratio.toFixed(2)}:1`
    ).toBeGreaterThanOrEqual(3);
  });
}
