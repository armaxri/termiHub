/**
 * The SSH tunnel types in plain words (#6027), in the rendered app at the
 * minimum window and the usual one, in dark and light: the type cards at rest
 * fit their row, hovering an unselected card and keyboard focus open its help
 * inside the window and off the card, a long agent name wraps in it, and the sidebar
 * row and the Port Forwarding section say what the type does too.
 *
 * Screenshots land in the usual screens/ folder for human review.
 */

import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

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
const EDITOR = "[data-testid=tunnel-editor]";
const TYPES = ["local", "remote", "dynamic"] as const;
const id = (testId: string) => `[data-testid="${testId}"]`;

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
}

/**
 * Move the pointer onto an element the way a hand does, in many small steps. A
 * tooltip that is open ignores moves that could be on their way into it, so a
 * single jump from one card to the next would not open the next card's help.
 */
async function hover(page: Page, target: Locator): Promise<void> {
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 20 });
}

/** Boot the seeded app on the Tunnels sidebar in `theme`. */
async function boot(page: Page, theme: string): Promise<void> {
  await page.addInitScript(() => {
    window.__VISUAL_SCENARIO__ = { populated: true };
  });
  await page.goto("/tests/visual/harness/index.html");
  await page.waitForFunction(() => window.__visual !== undefined);
  await page.locator(id("sidebar")).waitFor();
  await page.evaluate((t) => {
    const state = window.__visual.store.getState() as unknown as {
      sidebarView: string;
      setSidebarView(view: string): void;
    };
    if (state.sidebarView !== "tunnels") state.setSidebarView("tunnels");
    window.__visual.applyTheme(t);
  }, theme);
  await page.locator(id("tunnel-list")).waitFor();
}

/** Open the editor for a new tunnel (Local is selected). */
async function openEditor(page: Page): Promise<void> {
  await page.locator(id("tunnel-new-btn")).click();
  await page.locator(EDITOR).waitFor();
  await page.locator(id("tunnel-editor-type-selector")).scrollIntoViewIfNeeded();
  await settle(page);
}

for (const viewport of [
  { width: 800, height: 600 },
  { width: 1280, height: 800 },
]) {
  const size = `${viewport.width}x${viewport.height}`;

  for (const theme of ["dark", "light"]) {
    test.describe(`tunnel type help at ${size}, ${theme}`, () => {
      test.use({ viewport });

      async function shoot(page: Page, name: string): Promise<void> {
        await settle(page);
        const path = join(SCREENS, "tunnel-type-help", `${name}--${size}--${theme}.png`);
        await page.screenshot({ path });
        await test.info().attach(`${name} (${size}, ${theme})`, { path, contentType: "image/png" });
      }

      /** The editor passes the layout audit and no card's text leaves the card. */
      async function checkCards(page: Page, name: string): Promise<void> {
        const issues = await page.evaluate(auditLayout, {
          root: EDITOR,
          styledClasses: STYLED_CLASSES,
        });
        expect.soft(issues, name).toEqual([]);
        for (const type of TYPES) {
          const overflow = await page.locator(id(`tunnel-type-${type}`)).evaluate((el) => {
            const card = el.getBoundingClientRect();
            return Array.from(el.querySelectorAll("*")).some((child) => {
              const box = child.getBoundingClientRect();
              return box.right > card.right + 1 || box.bottom > card.bottom + 1;
            });
          });
          expect.soft(overflow, `${name}: ${type} card`).toBe(false);
        }
        const editor = await page
          .locator(EDITOR)
          .evaluate((el) => [el.scrollWidth, el.clientWidth]);
        expect.soft(editor[0], `${name} scrolls sideways`).toBeLessThanOrEqual(editor[1]);
      }

      /** The help is inside the window, unclipped, and does not cover its trigger. */
      async function checkHelp(help: Locator, trigger: Locator): Promise<void> {
        // Radix mounts the tooltip off-screen and places it a frame later.
        await expect.poll(async () => (await help.boundingBox())?.y ?? -1).toBeGreaterThan(0);
        const box = (await help.boundingBox())!;
        const card = (await trigger.boundingBox())!;
        expect.soft(box.x).toBeGreaterThanOrEqual(0);
        expect.soft(box.x + box.width).toBeLessThanOrEqual(viewport.width);
        expect.soft(box.y + box.height).toBeLessThanOrEqual(viewport.height);
        const covers = box.y < card.y + card.height && card.y < box.y + box.height;
        expect.soft(covers, "the help covers its card").toBe(false);
        const clipped = await help.evaluate((el) => el.scrollWidth > el.clientWidth);
        expect.soft(clipped, "the help text is cut").toBe(false);
      }

      test("cards at rest, hovered and focused", async ({ page }) => {
        await boot(page, theme);
        await openEditor(page);
        await checkCards(page, "rest");
        await shoot(page, "cards-rest");

        // Hover a card that is not selected: its help, and nothing changes.
        const remote = page.locator(id("tunnel-type-remote"));
        await hover(page, remote);
        await checkHelp(page.locator(id("tunnel-type-remote-help")), remote);
        await expect(page.locator(id("tunnel-type-local"))).toBeChecked();
        await shoot(page, "cards-hover");
        // Keep the selected style while its own help is open.
        const border = (locator: Locator) =>
          locator.evaluate((el) => getComputedStyle(el).borderTopColor);
        const selected = await border(page.locator(id("tunnel-type-local")));
        await hover(page, page.locator(id("tunnel-type-local")));
        await page.locator(id("tunnel-type-local-help")).waitFor();
        expect(await border(page.locator(id("tunnel-type-local")))).toBe(selected);
        await page.mouse.move(0, 0);

        // Keyboard: Tab from the host selector, then the arrow keys.
        await page.locator(id("tunnel-editor-host")).focus();
        await page.keyboard.press("Tab");
        await expect(page.locator(id("tunnel-type-local"))).toBeFocused();
        await checkHelp(
          page.locator(id("tunnel-type-local-help")),
          page.locator(id("tunnel-type-local"))
        );
        await page.keyboard.press("ArrowRight", { delay: 100 });
        await page.keyboard.press("ArrowRight", { delay: 100 });
        const dynamic = page.locator(id("tunnel-type-dynamic"));
        await expect(dynamic).toBeChecked();
        await expect(dynamic).toBeFocused();
        await checkHelp(page.locator(id("tunnel-type-dynamic-help")), dynamic);
        await shoot(page, "cards-focus");
        // Escape closes the help first and keeps the editor open.
        await page.keyboard.press("Escape");
        await expect(page.locator(id("tunnel-type-dynamic-help"))).toHaveCount(0);
        await expect(page.locator(EDITOR)).toBeVisible();
      });

      test("cards name the agent that hosts the tunnel", async ({ page }) => {
        await boot(page, theme);
        await openEditor(page);
        await page.locator(id("tunnel-editor-host")).click();
        await page.getByRole("option", { name: /Raspberry Pi in the lab/ }).click();
        await settle(page);
        await checkCards(page, "agent");
        const remote = page.locator(id("tunnel-type-remote"));
        await expect(remote).toContainText("on the agent's side");
        await shoot(page, "agent-rest");
        await page.locator(id("tunnel-editor-endpoints")).scrollIntoViewIfNeeded();
        await shoot(page, "agent-diagram");
        await remote.scrollIntoViewIfNeeded();
        await hover(page, remote);
        const help = page.locator(id("tunnel-type-remote-help"));
        await checkHelp(help, remote);
        await expect(help).toContainText(
          "agent Raspberry Pi in the lab behind the office firewall"
        );
        await shoot(page, "agent-hover");
      });

      // A tooltip below its row lay on the next one and took its hover: on the way
      // down the list, or with the pointer resting on a row it crosses, the row
      // that is pointed at said nothing.
      test("a row's tooltip leaves the next row its own", async ({ page }) => {
        await boot(page, theme);
        const tooltip = (tunnel: string) => page.locator(id(`tunnel-tooltip-${tunnel}`)).first();
        const next = page.locator(id("tunnel-name-tun-socks"));
        await hover(page, page.locator(id("tunnel-name-tun-db")));
        await expect(tooltip("tun-db")).toBeVisible();
        const shown = (await tooltip("tun-db").boundingBox())!;
        const row = (await page.locator(id("tunnel-item-tun-db")).boundingBox())!;
        expect(shown.x).toBeGreaterThanOrEqual(row.x + row.width);
        await hover(page, next);
        await expect(tooltip("tun-socks")).toBeVisible();
        await expect(tooltip("tun-db")).toHaveCount(0);
      });

      test("the sidebar row's tooltip and the Port Forwarding section", async ({ page }) => {
        await boot(page, theme);
        await hover(page, page.locator(id("tunnel-name-tun-socks")));
        await expect(page.locator(id("tunnel-tooltip-tun-socks")).first()).toContainText(
          "Use the SSH server as a proxy for many destinations."
        );
        await shoot(page, "row-tooltip");
        // Away along the top edge, so the way to the editor crosses no row: a row
        // passed on it would show its tooltip over the editor.
        await page.mouse.move(viewport.width - 1, 0, { steps: 20 });
        await expect(page.locator(id("tunnel-tooltip-tun-socks"))).toHaveCount(0);
        await page.evaluate(() => {
          void window.__visual.store.getState().openConnectionEditorTab("Work/Build Box");
        });
        const type = page.locator(id("port-forward-type-tun-db"));
        await type.scrollIntoViewIfNeeded();
        const issues = await page.evaluate(auditLayout, {
          root: id("connection-port-forwarding-section"),
          styledClasses: STYLED_CLASSES,
        });
        expect.soft(issues).toEqual([]);
        await hover(page, type);
        await checkHelp(page.locator(id("port-forward-type-help-tun-db")), type);
        await shoot(page, "port-forwarding");
      });
    });
  }
}
