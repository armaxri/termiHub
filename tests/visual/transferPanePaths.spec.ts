/**
 * #5541: the transfer view's pane path bars, rendered by the real
 * `TransferPane` in a gallery (harness/transfer-pane-paths.html) with long
 * local, long remote and deep Windows paths at a comfortable and a narrow pane
 * width, in every built-in theme. Checks that the bar never overflows its pane,
 * that the current folder stays visible while the middle of a long path folds
 * into "…", that the full path stays the tooltip, and that clicking the
 * current folder opens an editor holding the full path at the bar's height
 * (#5540); then screenshots each theme.
 */

import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { SCREENS } from "./surfaces";

const THEMES = ["dark", "light", "solarized-dark", "solarized-light"] as const;

/** The one cell whose path fits its bar unfolded. */
const UNFOLDED = "short-local";

test.use({ viewport: { width: 1000, height: 900 } });

/** Per cell: what the pane's path bar looks like, measured in the page. */
interface CellReport {
  id: string;
  path: string;
  title: string | null;
  collapsed: boolean;
  firstLabel: string;
  leafLabel: string;
  leafWhole: boolean;
  issues: string[];
}

test("transfer panes keep long paths legible with the current folder visible", async ({
  page,
}, testInfo) => {
  for (const theme of THEMES) {
    await page.goto(`/tests/visual/harness/transfer-pane-paths.html?theme=${theme}`);
    const gallery = page.locator("[data-testid=transfer-pane-paths-gallery]");
    await gallery.waitFor();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    // Two frames: the ResizeObserver widths, then the measured layout.
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
    );

    const cells: CellReport[] = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-testid^=tpg-cell-]")).map((cell) => {
        const issues: string[] = [];
        const pane = cell.querySelector<HTMLElement>(".transfer-pane")!;
        const toolbar = cell.querySelector<HTMLElement>(".transfer-pane__toolbar")!;
        const nav = cell.querySelector<HTMLElement>("[data-testid$=-current-path]")!;
        const box = (el: Element) => el.getBoundingClientRect();
        const within = (inner: DOMRect, outer: DOMRect) =>
          inner.left >= outer.left - 1 && inner.right <= outer.right + 1;

        if (toolbar.scrollWidth > toolbar.clientWidth + 1) issues.push("toolbar overflows");
        if (!within(box(toolbar), box(pane))) issues.push("toolbar wider than the pane");
        const groups = Array.from(
          nav.querySelectorAll<HTMLElement>(":scope > .file-browser__crumb-group")
        );
        for (const g of groups) {
          if (!within(box(g), box(nav))) issues.push(`segment "${g.textContent}" is clipped`);
        }
        for (const b of Array.from(toolbar.querySelectorAll<HTMLElement>(":scope > button"))) {
          if (!within(box(b), box(toolbar))) {
            issues.push(`button "${b.getAttribute("aria-label")}" is clipped`);
          }
        }
        const labels = groups.map((g) => (g.textContent ?? "").trim());
        const leaf = groups[groups.length - 1]?.querySelector("button");
        return {
          id: cell.dataset.testid!.replace("tpg-cell-", ""),
          path: cell.dataset.path!,
          title: nav.getAttribute("title"),
          collapsed: nav.hasAttribute("data-collapsed"),
          firstLabel: labels[0] ?? "",
          leafLabel: labels[labels.length - 1] ?? "",
          leafWhole: !!leaf && leaf.scrollWidth <= leaf.clientWidth + 1,
          issues,
        };
      })
    );

    expect(cells.length, `${theme}: every gallery cell rendered`).toBe(7);
    for (const c of cells) {
      const where = `${theme} / ${c.id}`;
      expect.soft(c.issues, where).toEqual([]);
      expect.soft(c.title, `${where}: the full path is the tooltip`).toBe(c.path);
      expect
        .soft(c.leafLabel, `${where}: the current folder stays visible`)
        .toBe(c.path.split("/").pop());
      expect.soft(c.leafWhole, `${where}: the current folder shows its whole name`).toBe(true);
      expect.soft(c.collapsed, `${where}: a long path folds its middle`).toBe(c.id !== UNFOLDED);
      if (c.id.includes("windows")) {
        expect.soft(c.firstLabel, `${where}: a Windows path keeps its drive`).toBe("C:");
      }
    }

    const file = join(SCREENS, "transfer-pane-paths", `gallery-${theme}.png`);
    await gallery.screenshot({ path: file });
    await testInfo.attach(`transfer pane paths (${theme})`, {
      path: file,
      contentType: "image/png",
    });

    // Clicking the current folder edits the full path at the bar's height.
    const narrow = page.locator("[data-testid=tpg-cell-narrow-remote]");
    const bar = narrow.locator(".file-browser__path-bar");
    const before = await bar.boundingBox();
    await narrow.locator("[data-testid=transfer-pane-remote-crumb-img]").click();
    const input = narrow.locator("[data-testid=transfer-pane-remote-path-input]");
    await expect(input).toBeFocused();
    const narrowPath = await narrow.getAttribute("data-path");
    await expect(input).toHaveValue(narrowPath!);
    const after = await bar.boundingBox();
    expect.soft(after?.height, `${theme}: the editor keeps the bar's height`).toBe(before?.height);
    await page.keyboard.press("Escape");
    await expect(input).toHaveCount(0);
  }
});
