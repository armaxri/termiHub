/**
 * #5557: terminal tabs size to their title. The product-run UI review saw
 * "Startup question (zs…" cut at ~150px with the rest of the strip empty. In a
 * real layout this checks that a typical session name is shown whole while the
 * strip has room, that tabs stay within the 120–240px band, that a full strip
 * compresses its tabs (never below 120px) before it scrolls, and that the full
 * title stays the tab's tooltip.
 */

import { expect, test, type Page } from "@playwright/test";

import type { VisualScenario } from "./harness/mockBackend";
import type { VisualHandle } from "./harness/visualHandle";

declare global {
  interface Window {
    /** What the harness exposes (see harness/boot.ts). */
    __visual: VisualHandle;
  }
}

const TITLE = "Startup question (zsh)";
/** A typical SSH tab title, wider than the old 200px cap but within 240px. */
const SSH_TITLE = "ops@build-box.example.com";

test.use({ viewport: { width: 1280, height: 800 } });

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
}

async function boot(page: Page, scenario: VisualScenario): Promise<void> {
  await page.addInitScript((s) => {
    window.__VISUAL_SCENARIO__ = s;
  }, scenario);
  await page.goto("/tests/visual/harness/index.html");
  await page.waitForFunction(() => window.__visual !== undefined);
  await page.locator("[data-testid=sidebar]").waitFor();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await settle(page);
}

async function addTabs(page: Page, titles: string[]): Promise<string[]> {
  const ids = await page.evaluate(
    (all) =>
      all.map(
        (title) =>
          window.__visual.store
            .getState()
            .addTab(
              title,
              "local",
              { type: "local", config: {} },
              { contentType: "terminal" }
            ) as string
      ),
    titles
  );
  await settle(page);
  return ids;
}

/** Width of each tab, and whether its title is ellipsized. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>("[data-testid=tab-bar]")!;
    const tabs = Array.from(bar.querySelectorAll<HTMLElement>("[role=tab]")).map((tab) => {
      const title = tab.querySelector<HTMLElement>(".tab__title")!;
      return {
        width: tab.getBoundingClientRect().width,
        clipped: title.scrollWidth > title.clientWidth + 1,
        tooltip: tab.getAttribute("title"),
        text: (title.textContent ?? "").trim(),
      };
    });
    return { tabs, scrolls: bar.scrollWidth > bar.clientWidth + 1 };
  });
}

test("session names are shown whole while the strip has room", async ({ page }) => {
  await boot(page, { terminal: true });
  await addTabs(page, [TITLE, SSH_TITLE]);
  const { tabs, scrolls } = await measure(page);
  for (const title of [TITLE, SSH_TITLE]) {
    const tab = tabs.find((t) => t.text === title)!;
    expect(tab, `the "${title}" tab renders`).toBeDefined();
    expect(tab.clipped, `"${title}" is ellipsized at ${tab.width}px`).toBe(false);
    expect(tab.width).toBeGreaterThanOrEqual(119.5);
    expect(tab.width).toBeLessThanOrEqual(240.5);
    expect(tab.tooltip).toBe(title);
  }
  expect(scrolls, "two tabs never scroll the strip").toBe(false);
});

test("a full strip compresses its tabs to no less than 120px", async ({ page }) => {
  await boot(page, { terminal: true });
  await addTabs(
    page,
    Array.from({ length: 14 }, (_, i) => `Production database replica ${i + 1}`)
  );
  const { tabs, scrolls } = await measure(page);
  expect(tabs.length).toBeGreaterThanOrEqual(14);
  // The strip scrolls only once every tab is already at its minimum width.
  if (scrolls) {
    for (const tab of tabs) expect(tab.width, `"${tab.text}" before scrolling`).toBeLessThan(121);
  }
  for (const tab of tabs) {
    expect(tab.width, `"${tab.text}" width`).toBeGreaterThanOrEqual(119.5);
    expect(tab.width, `"${tab.text}" width`).toBeLessThanOrEqual(240.5);
    // A clipped title still names itself in full in the tooltip.
    if (tab.clipped) expect(tab.tooltip).toBe(tab.text);
  }
  // Long titles at 1280px cannot all fit at 240px, so the strip shrank them.
  expect(tabs.some((t) => t.width < 239)).toBe(true);
});

test("a full strip truncates titles in the middle, keeping their ends (#5827)", async ({
  page,
}) => {
  await boot(page, { terminal: true });
  // Names that share a long prefix and differ only at the end, like the
  // product run's `sys-pr-telnet-<hex>` connections.
  const titles = Array.from(
    { length: 14 },
    (_, i) => `sys-pr-telnet-${(0x1a2b3c00 + i).toString(16)}`
  );
  const ids = await addTabs(page, titles);
  const tails = await page.evaluate(
    (all) =>
      all.map((id) => {
        const tab = document.querySelector<HTMLElement>(`[data-testid="tab-${id}"]`)!;
        const head = tab.querySelector<HTMLElement>(".tab__title-head")!;
        const tail = tab.querySelector<HTMLElement>(".tab__title-tail")!;
        const t = tail.getBoundingClientRect();
        const r = tab.getBoundingClientRect();
        return {
          headClipped: head.scrollWidth > head.clientWidth + 1,
          tailWhole: tail.scrollWidth <= tail.clientWidth + 1,
          tailInside: t.width > 0 && t.left >= r.left - 1 && t.right <= r.right + 1,
          tail: tail.textContent,
        };
      }),
    ids
  );
  // The strip is full, so the heads are ellipsized …
  expect(tails.some((t) => t.headClipped)).toBe(true);
  // … but every tab keeps its distinguishing end whole and on screen.
  for (const [i, t] of tails.entries()) {
    expect(t.tail).toBe(titles[i].slice(-8));
    expect(t.tailWhole, `"${titles[i]}" tail is clipped`).toBe(true);
    expect(t.tailInside, `"${titles[i]}" tail escapes its tab`).toBe(true);
  }
  expect(new Set(tails.map((t) => t.tail)).size).toBe(titles.length);
});
