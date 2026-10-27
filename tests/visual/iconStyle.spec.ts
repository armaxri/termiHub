/**
 * Per-connection (#5008) and per-folder (#5020) icon colour and emoji,
 * rendered in the real frontend.
 *
 * Seeds root connections with emoji icons, palette colours and a near-black
 * custom hex (harness/mockBackend.ts `ICON_STYLE_ROWS`), then, in the Dark and
 * the Light theme: checks each emoji row draws its emoji, each coloured row
 * keeps >= 3:1 contrast against the sidebar background (the renderer nudges
 * poor custom colours), and screenshots the sidebar for human review.
 */

import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import type { VisualScenario } from "./harness/mockBackend";
import type { VisualHandle } from "./harness/visualHandle";
import { SCREENS } from "./surfaces";

declare global {
  interface Window {
    /** What the harness exposes (see harness/boot.ts). */
    __visual: VisualHandle;
  }
}

const THEMES = ["dark", "light"] as const;
const EMOJI_ROWS: Record<string, string> = {
  "icon-emoji": "\u{1F680}",
  "icon-teal-emoji": "\u{1F433}",
};
const COLOURED_ROWS = ["icon-red", "icon-yellow", "icon-custom-dark"];
const connectionRow = (id: string) => `[data-testid="connection-item-${id}"]`;
const folderRow = (id: string) => `[data-testid="folder-toggle-${id}"]`;
const COLOURED_FOLDERS = ["Customers", "Lab"];

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
  await settle(page);
}

/** WCAG contrast of a row icon's stroke against the sidebar background. */
async function iconContrast(page: Page, rowSelector: string): Promise<number> {
  return page.evaluate((row) => {
    const parse = (c: string): number[] => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const lum = ([r, g, b]: number[]): number => {
      const ch = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
    };
    const svg = document.querySelector(`${row} svg`);
    const sidebar = document.querySelector("[data-testid=sidebar]");
    if (!svg || !sidebar) return 0;
    const fg = lum(parse(getComputedStyle(svg).stroke));
    const bg = lum(parse(getComputedStyle(sidebar).backgroundColor));
    return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
  }, rowSelector);
}

test.use({ viewport: { width: 1280, height: 800 } });

test("connection rows show icon colours and emoji legibly in Dark and Light", async ({
  page,
}, testInfo) => {
  await boot(page, { iconStyles: true });
  for (const theme of THEMES) {
    await page.evaluate((t) => window.__visual.applyTheme(t), theme);
    await settle(page);

    for (const [id, emoji] of Object.entries(EMOJI_ROWS)) {
      await expect(
        page.locator(`[data-testid="connection-item-${id}"] [data-testid=connection-icon-emoji]`),
        `${theme}: ${id} draws its emoji`
      ).toHaveText(emoji);
    }
    for (const id of COLOURED_ROWS) {
      const svg = page.locator(`[data-testid="connection-item-${id}"] svg`).first();
      await expect(svg, `${theme}: ${id} is tinted`).toHaveAttribute("data-icon-color", /.+/);
      expect(
        await iconContrast(page, connectionRow(id)),
        `${theme}: ${id} keeps >= 3:1 against the sidebar`
      ).toBeGreaterThanOrEqual(3);
    }

    await expect(
      page.locator(`${folderRow("Containers")} [data-testid=folder-icon-emoji]`),
      `${theme}: the Containers folder draws its emoji`
    ).toHaveText("\u{1F4E6}");
    for (const id of COLOURED_FOLDERS) {
      const svg = page.locator(`${folderRow(id)} [data-testid=folder-icon]`);
      await expect(svg, `${theme}: folder ${id} is tinted`).toHaveAttribute(
        "data-icon-color",
        /.+/
      );
      expect(
        await iconContrast(page, folderRow(id)),
        `${theme}: folder ${id} keeps >= 3:1 against the sidebar`
      ).toBeGreaterThanOrEqual(3);
    }

    const file = join(SCREENS, "icon-style", `sidebar-${theme}.png`);
    await page.locator("[data-testid=sidebar]").screenshot({ path: file });
    await testInfo.attach(`icon-style sidebar (${theme})`, {
      path: file,
      contentType: "image/png",
    });
  }

  // The editor's Appearance tab with a colour + emoji set, in both themes.
  await page.evaluate(() => {
    void window.__visual.store.getState().openConnectionEditorTab("icon-teal-emoji");
  });
  const editor = page.locator('.connection-editor:not([style*="display: none"])');
  await editor.locator("[data-testid=settings-nav-appearance]").click();
  await expect(editor.locator("[data-testid=icon-color-swatch-teal]")).toHaveAttribute(
    "aria-checked",
    "true"
  );
  await expect(editor.locator("[data-testid=connection-editor-icon-emoji]")).toHaveValue(
    "\u{1F433}"
  );
  for (const theme of THEMES) {
    await page.evaluate((t) => window.__visual.applyTheme(t), theme);
    await settle(page);
    const file = join(SCREENS, "icon-style", `editor-appearance-${theme}.png`);
    await editor.screenshot({ path: file });
    await testInfo.attach(`icon-style editor (${theme})`, { path: file, contentType: "image/png" });
  }

  // The searchable emoji picker (bundled data, no network), in both themes.
  const external: string[] = [];
  page.on("request", (req) => {
    if (!req.url().startsWith(new URL(page.url()).origin)) external.push(req.url());
  });
  await editor.locator("[data-testid=connection-editor-choose-icon-emoji]").click();
  const dialog = page.getByRole("dialog");
  // The first button is frimousse's hidden sizer; wait for a real one.
  await dialog.locator("[data-testid=emoji-picker-emoji]", { hasText: "\u{1F600}" }).waitFor();
  for (const theme of THEMES) {
    await page.evaluate((t) => window.__visual.applyTheme(t), theme);
    await settle(page);
    const file = join(SCREENS, "icon-style", `emoji-picker-${theme}.png`);
    await dialog.screenshot({ path: file });
    await testInfo.attach(`icon-style emoji picker (${theme})`, {
      path: file,
      contentType: "image/png",
    });
  }
  await dialog.locator("[data-testid=emoji-picker-search]").fill("penguin");
  await dialog.locator("[data-testid=emoji-picker-emoji]", { hasText: "\u{1F427}" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(editor.locator("[data-testid=connection-editor-icon-emoji]")).toHaveValue(
    "\u{1F427}"
  );
  expect(external, "the emoji picker made no network requests").toEqual([]);
});

test("a folder's Appearance dialog edits its icon colour and emoji in Dark and Light", async ({
  page,
}, testInfo) => {
  await boot(page, { iconStyles: true });
  await page.locator(folderRow("Customers")).click({ button: "right" });
  await page.locator("[data-testid=context-folder-appearance]").click();
  const dialog = page.locator("[data-testid=folder-appearance-dialog]");
  await expect(dialog.locator("[data-testid=icon-color-swatch-purple]")).toHaveAttribute(
    "aria-checked",
    "true"
  );
  await dialog.locator("[data-testid=connection-editor-icon-emoji]").fill("\u{1F465}");
  await expect(dialog.locator("[data-testid=folder-appearance-preview]")).toContainText(
    "\u{1F465}"
  );

  for (const theme of THEMES) {
    await page.evaluate((t) => window.__visual.applyTheme(t), theme);
    await settle(page);
    const file = join(SCREENS, "icon-style", `folder-appearance-${theme}.png`);
    await dialog.screenshot({ path: file });
    await testInfo.attach(`icon-style folder appearance (${theme})`, {
      path: file,
      contentType: "image/png",
    });
  }

  await dialog.locator("[data-testid=folder-appearance-cancel]").click();
  await expect(dialog).toHaveCount(0);
});
