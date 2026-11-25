/**
 * Every state of a tunnel and of a file server (#6028), in the rendered app at
 * the minimum window and the usual one, in dark and light: each row's dot reads
 * its state, the reason under the name is complete and inside the row, the run
 * button is there, and a ring tells "not reachable" from green without colour.
 *
 * Screenshots land in the usual screens/ folder for human review.
 */

import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import type { VisualHandle } from "./harness/visualHandle";
import { auditLayout } from "./layoutAudit";
import { SCREENS } from "./surfaces";
import { styledPrimitiveClasses } from "./uiClasses";

declare global {
  interface Window {
    __visual: VisualHandle;
  }
}

const STYLED_CLASSES = styledPrimitiveClasses();
const id = (testId: string) => `[data-testid="${testId}"]`;

/** The rows of the `serviceStates` scenario: state word and run button. */
const ROWS: [row: string, word: string, run: string | null, reason: boolean][] = [
  ["stopped", "Stopped", "Start", false],
  ["waiting", "Waiting", "Stop waiting", true],
  ["waiting-store", "Waiting", "Stop waiting", true],
  ["starting", "Starting", "Stop", false],
  ["running", "Running", "Stop", false],
  ["stopping", "Stopping", "Stop", true],
  ["deleted", "Needs a connection", null, false],
  ["away", "Not reachable", "Stop", true],
  ["unknown", "Not reachable", "Stop", true],
];

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
}

async function boot(page: Page, theme: string, view: string, list: string): Promise<void> {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    window.__VISUAL_SCENARIO__ = { populated: true, serviceStates: true };
  });
  await page.goto("/tests/visual/harness/index.html");
  await page.waitForFunction(() => window.__visual !== undefined);
  await page.locator(id("sidebar")).waitFor();
  await page.evaluate(
    ([t, v]) => {
      const state = window.__visual.store.getState() as unknown as {
        sidebarView: string;
        setSidebarView(view: string): void;
      };
      if (state.sidebarView !== v) state.setSidebarView(v);
      window.__visual.applyTheme(t);
    },
    [theme, view]
  );
  await page.locator(id(list)).waitFor();
  await settle(page);
}

for (const viewport of [
  { width: 800, height: 600 },
  { width: 1280, height: 800 },
]) {
  const size = `${viewport.width}x${viewport.height}`;
  for (const theme of ["dark", "light"]) {
    for (const kind of [
      { name: "tunnels", view: "tunnels", list: "tunnel-list", prefix: "tunnel", row: "tun" },
      { name: "servers", view: "services", list: "server-list", prefix: "server", row: "srv" },
    ]) {
      test.describe(`service states: ${kind.name} at ${size}, ${theme}`, () => {
        test.use({ viewport });

        test("every row says its state, why, and offers its button", async ({ page }) => {
          await boot(page, theme, kind.view, kind.list);
          const issues = await page.evaluate(auditLayout, {
            root: id(kind.list),
            styledClasses: STYLED_CLASSES,
          });
          expect.soft(issues).toEqual([]);

          for (const [row, word, run, reason] of ROWS) {
            if (kind.name === "servers" && row === "deleted") continue;
            const rowId = `${kind.row}-${row}`;
            const item = page.locator(id(`${kind.prefix}-item-${rowId}`));
            const dot = page.locator(id(`${kind.prefix}-status-${rowId}`));
            await expect.soft(dot, rowId).toHaveAttribute("aria-label", word);
            const button = page.locator(`${id(`${kind.prefix}-primary-${rowId}`)} button`);
            if (run) await expect.soft(button, rowId).toHaveAttribute("aria-label", run);
            else await expect.soft(button, rowId).toHaveCount(0);

            const line = page.locator(id(`${kind.prefix}-reason-${rowId}`));
            await expect.soft(line, rowId).toHaveCount(reason ? 1 : 0);
            if (!reason) continue;
            const box = await line.evaluate((el) => {
              const own = el.getBoundingClientRect();
              const row = el.closest(".sidebar-list-item")!.getBoundingClientRect();
              return {
                cut: el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0,
                inside: own.right <= row.right + 1 && own.bottom <= row.bottom + 1,
              };
            });
            expect.soft(box, `${rowId}: the reason is complete`).toEqual({
              cut: false,
              inside: true,
            });
            await item.scrollIntoViewIfNeeded();
          }

          // A ring for "cannot tell", a filled dot for the rest.
          const fill = (row: string) =>
            page
              .locator(id(`${kind.prefix}-status-${kind.row}-${row}`))
              .evaluate((el) => getComputedStyle(el).backgroundColor);
          expect.soft(await fill("away")).toBe("rgba(0, 0, 0, 0)");
          expect.soft(await fill("waiting")).not.toBe("rgba(0, 0, 0, 0)");
          expect.soft(await fill("running")).not.toBe(await fill("waiting"));

          const sideways = await page
            .locator(id(kind.list))
            .evaluate((el) => el.scrollWidth - el.clientWidth);
          expect.soft(sideways, "the list scrolls sideways").toBeLessThanOrEqual(0);

          for (const part of ["top", "bottom"]) {
            await page
              .locator(
                id(`${kind.prefix}-item-${kind.row}-${part === "top" ? "stopped" : "unknown"}`)
              )
              .scrollIntoViewIfNeeded();
            await settle(page);
            const path = join(
              SCREENS,
              "service-states",
              `${kind.name}-${part}--${size}--${theme}.png`
            );
            await page.screenshot({ path });
          }
        });
      });
    }
  }
}
