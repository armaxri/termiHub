/**
 * #5520 / #5521: the file browser header, rendered by the real path bar and
 * action row in a gallery (harness/file-browser-header.html) with long local,
 * long remote and deep Windows paths at the default and the minimum sidebar
 * width, in every built-in theme. Checks that nothing clips or overflows its
 * sidebar, that the leaf folder stays visible while the middle of a long path
 * folds into "…", that the full path stays the tooltip, and that the action
 * row stays one line; then screenshots each theme and the overflow menu.
 */

import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { SCREENS } from "./surfaces";

const THEMES = ["dark", "light", "solarized-dark", "solarized-light"] as const;

/** The one cell whose path fits its bar unfolded. */
const UNFOLDED = "short-local";
/** The one cell whose leaf alone is wider than the bar (it ellipsizes). */
const WIDE_LEAF = "long-leaf";

test.use({ viewport: { width: 1000, height: 900 } });

/** Per cell: what the header looks like, measured in the page. */
interface CellReport {
  id: string;
  path: string;
  title: string | null;
  collapsed: boolean;
  firstLabel: string;
  leafLabel: string;
  /** The leaf segment shows its whole name (not ellipsized). */
  leafWhole: boolean;
  issues: string[];
}

test("the file browser header keeps long paths legible and its actions on one row", async ({
  page,
}, testInfo) => {
  for (const theme of THEMES) {
    await page.goto(`/tests/visual/harness/file-browser-header.html?theme=${theme}`);
    const gallery = page.locator("[data-testid=file-browser-header-gallery]");
    await gallery.waitFor();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    // Two frames: the ResizeObserver widths, then the measured layout.
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
    );

    const cells: CellReport[] = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-testid^=fbg-cell-]")).map((cell) => {
        const issues: string[] = [];
        const sidebar = cell.querySelector<HTMLElement>(".fbg-sidebar")!;
        const toolbar = cell.querySelector<HTMLElement>(".file-browser__toolbar")!;
        const nav = cell.querySelector<HTMLElement>("[data-testid=file-browser-current-path]")!;
        const row = cell.querySelector<HTMLElement>("[data-testid=file-browser-actions]")!;
        const box = (el: Element) => el.getBoundingClientRect();
        const within = (inner: DOMRect, outer: DOMRect) =>
          inner.left >= outer.left - 1 && inner.right <= outer.right + 1;

        if (toolbar.scrollWidth > toolbar.clientWidth + 1) issues.push("header overflows");
        if (!within(box(toolbar), box(sidebar))) issues.push("header wider than the sidebar");
        const groups = Array.from(
          nav.querySelectorAll<HTMLElement>(":scope > .file-browser__crumb-group")
        );
        for (const g of groups) {
          if (!within(box(g), box(nav))) issues.push(`segment "${g.textContent}" is clipped`);
        }
        const buttons = Array.from(row.querySelectorAll<HTMLElement>(":scope > button"));
        for (const b of buttons) {
          if (!within(box(b), box(row))) {
            issues.push(`action "${b.getAttribute("aria-label")}" is clipped`);
          }
        }
        const tops = new Set(buttons.map((b) => Math.round(box(b).top)));
        if (tops.size > 1) issues.push("the action row wraps");
        const labels = groups.map((g) => (g.textContent ?? "").trim());
        const leaf = groups[groups.length - 1]?.querySelector("button");
        return {
          id: cell.dataset.testid!.replace("fbg-cell-", ""),
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

    expect(cells.length, `${theme}: every gallery cell rendered`).toBe(8);
    for (const c of cells) {
      const where = `${theme} / ${c.id}`;
      expect.soft(c.issues, where).toEqual([]);
      expect.soft(c.title, `${where}: the full path is the tooltip`).toBe(c.path);
      expect
        .soft(c.leafLabel, `${where}: the leaf folder stays visible`)
        .toBe(c.path.split("/").pop());
      expect.soft(c.leafWhole, `${where}: the leaf shows its whole name`).toBe(c.id !== WIDE_LEAF);
      expect.soft(c.collapsed, `${where}: a long path folds its middle`).toBe(c.id !== UNFOLDED);
    }
    const windows = cells.find((c) => c.id === "deep-windows");
    expect.soft(windows?.firstLabel, `${theme}: a Windows path keeps its drive`).toBe("C:");

    const file = join(SCREENS, "file-browser-header", `gallery-${theme}.png`);
    await gallery.screenshot({ path: file });
    await testInfo.attach(`file browser header (${theme})`, {
      path: file,
      contentType: "image/png",
    });

    // The narrow remote header's overflow menu: labelled entries, keyboard reachable.
    const narrow = page.locator("[data-testid=fbg-cell-narrow-remote]");
    await narrow.locator("[data-testid=file-browser-more-actions]").focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu");
    await menu.waitFor();
    const items = await menu.locator("[role^=menuitem]").allInnerTexts();
    expect
      .soft(items.length, `${theme}: the overflow menu lists the hidden actions`)
      .toBeGreaterThanOrEqual(5);
    for (const text of items) expect.soft(text.trim(), `${theme}: menu entry label`).not.toBe("");
    await expect(menu.locator("[role^=menuitem]").first()).toBeFocused();
    const menuFile = join(SCREENS, "file-browser-header", `overflow-menu-${theme}.png`);
    await page.screenshot({ path: menuFile });
    await testInfo.attach(`file browser overflow menu (${theme})`, {
      path: menuFile,
      contentType: "image/png",
    });
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  }
});
