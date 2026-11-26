/**
 * Bare-word choices in plain words (#6036), in the rendered app at the minimum
 * window and the usual one, in dark and light: serial parity and flow control,
 * the VNC encoding and the RDP security say what the chosen value means under
 * the select and every value in its list, with more in a help tooltip; the jump
 * host source and the agent binary source say it on their cards.
 *
 * Run `pnpm exec playwright test -c tests/visual/playwright.config.ts choiceHelp`.
 * The shots land in `test-results/screens/choice-help/`, named
 * `<state>--<window>--<theme>.png`, with `index.json` beside them: what the user
 * wants to do in each. Every shot is audited for layout, and each tooltip or
 * list is checked to sit inside the window, uncut.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { CHOICE_HELP_CONNECTIONS } from "./harness/choiceHelpIds";
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
const DIR = join(SCREENS, "choice-help");
const EDITOR = '.connection-editor:not([style*="display: none"])';
const id = (testId: string) => `[data-testid="${testId}"]`;

const STATES = {
  "serial--chosen": "Set up a serial console: what do the parity and flow control I chose mean?",
  "serial--list": "Pick the flow control: which of these is mine?",
  "rdp--list": "The desktop will not connect: which security should it use?",
  "vnc--help": "The remote screen is slow: what does the encoding I chose do?",
  "jump--help": "Add a jump host: a saved connection or typed here?",
  "agent--help": "Install an agent: where should its file come from?",
} as const;
type State = keyof typeof STATES;

const WINDOWS = [
  { width: 800, height: 600 },
  { width: 1280, height: 800 },
];
const THEMES = ["dark", "light"];

test.beforeAll(() => {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(
    join(DIR, "index.json"),
    `${JSON.stringify(
      Object.entries(STATES).map(([name, situation]) => ({
        name,
        situation,
        screenshots: WINDOWS.flatMap((w) =>
          THEMES.map((theme) => `${name}--${w.width}x${w.height}--${theme}.png`)
        ),
      })),
      null,
      2
    )}\n`
  );
});

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
}

/**
 * Wait until Radix has placed `content`. Until then its wrapper sits above the
 * window at `translate(0, -200%)` while it is measured.
 */
async function placed(content: Locator): Promise<void> {
  await expect
    .poll(() =>
      content.evaluate(
        (el) =>
          (el.closest("[data-radix-popper-content-wrapper]") as HTMLElement | null)?.style
            .transform ?? ""
      )
    )
    .not.toContain("-200%");
}

/** Move the pointer onto an element the way a hand does. */
async function hover(page: Page, target: Locator): Promise<void> {
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 20 });
}

async function boot(page: Page, theme: string): Promise<void> {
  await page.addInitScript(() => {
    window.__VISUAL_SCENARIO__ = { populated: true, choiceHelp: true };
  });
  await page.goto("/tests/visual/harness/index.html");
  await page.waitForFunction(() => window.__visual !== undefined);
  await page.locator(id("sidebar")).waitFor();
  await page.evaluate((t) => window.__visual.applyTheme(t), theme);
}

async function openConnection(page: Page, connectionId: string): Promise<Locator> {
  await page.evaluate((cid) => {
    void window.__visual.store.getState().openConnectionEditorTab(cid);
  }, connectionId);
  const editor = page.locator(EDITOR);
  await editor.waitFor();
  return editor;
}

for (const viewport of WINDOWS) {
  const size = `${viewport.width}x${viewport.height}`;

  for (const theme of THEMES) {
    test.describe(`choice help at ${size}, ${theme}`, () => {
      test.use({ viewport });

      /** `el` is inside the window and nothing in it is cut. */
      async function inWindow(el: Locator, what: string): Promise<void> {
        await expect.poll(async () => (await el.boundingBox())?.y ?? -1).toBeGreaterThanOrEqual(0);
        const box = (await el.boundingBox())!;
        expect.soft(box.x, `${what} left`).toBeGreaterThanOrEqual(0);
        expect.soft(box.x + box.width, `${what} right`).toBeLessThanOrEqual(viewport.width);
        expect.soft(box.y + box.height, `${what} bottom`).toBeLessThanOrEqual(viewport.height);
        const cut = await el.evaluate((node) => node.scrollWidth > node.clientWidth + 1);
        expect.soft(cut, `${what} is cut`).toBe(false);
      }

      async function shoot(page: Page, state: State, root: string): Promise<void> {
        await settle(page);
        const issues = await page.evaluate(auditLayout, { root, styledClasses: STYLED_CLASSES });
        expect.soft(issues, state).toEqual([]);
        const path = join(DIR, `${state}--${size}--${theme}.png`);
        await page.screenshot({ path });
        await test.info().attach(`${state} (${size}, ${theme})`, {
          path,
          contentType: "image/png",
        });
      }

      /** Open the help of a schema select's chosen value and check it. */
      async function choiceHelpOf(page: Page, field: string): Promise<void> {
        await page.locator(id(`field-${field}-choice-about`)).focus();
        const help = page.locator(id(`field-${field}-choice-help`));
        await help.waitFor();
        await placed(help);
        await inWindow(help, `${field} help`);
      }

      for (const state of Object.keys(STATES) as State[]) {
        test(state, async ({ page }) => {
          await boot(page, theme);
          switch (state) {
            case "serial--chosen": {
              const editor = await openConnection(page, CHOICE_HELP_CONNECTIONS.serial);
              await expect(editor.locator(id("field-parity-choice"))).toHaveText(
                "One extra bit makes the count of 1 bits even."
              );
              await expect(editor.locator(id("field-flowControl-choice"))).toHaveText(
                "The RTS and CTS wires pause the sender."
              );
              await editor.locator(id("field-flowControl")).scrollIntoViewIfNeeded();
              await choiceHelpOf(page, "flowControl");
              await shoot(page, state, EDITOR);
              break;
            }
            case "serial--list": {
              const editor = await openConnection(page, CHOICE_HELP_CONNECTIONS.serial);
              await editor.locator(id("field-flowControl")).scrollIntoViewIfNeeded();
              await editor.locator(id("field-flowControl")).click();
              const list = page.locator(".ui-select__content");
              await list.waitFor();
              await expect(list).toContainText("XON and XOFF characters pause the sender");
              await inWindow(list, "flow control list");
              await shoot(page, state, EDITOR);
              break;
            }
            case "rdp--list": {
              const editor = await openConnection(page, CHOICE_HELP_CONNECTIONS.rdp);
              await editor.locator(id("field-securityMode")).click();
              const list = page.locator(".ui-select__content");
              await list.waitFor();
              await expect(list).toContainText("Old, weak encryption; only for old servers");
              await inWindow(list, "security list");
              await shoot(page, state, EDITOR);
              break;
            }
            case "vnc--help": {
              const editor = await openConnection(page, CHOICE_HELP_CONNECTIONS.vnc);
              await expect(editor.locator(id("field-preferredEncoding-choice"))).toHaveText(
                "Uncompressed; only for a very fast link."
              );
              await choiceHelpOf(page, "preferredEncoding");
              await shoot(page, state, EDITOR);
              break;
            }
            case "jump--help": {
              const editor = await openConnection(page, CHOICE_HELP_CONNECTIONS.hop);
              const saved = editor.locator(id("jump-host-source-saved-0"));
              await saved.scrollIntoViewIfNeeded();
              await expect(saved).toContainText("An SSH connection you saved");
              await hover(page, saved);
              const help = page.locator(id("jump-host-source-saved-0-help"));
              await help.waitFor();
              await placed(help);
              await inWindow(help, "saved source help");
              await shoot(page, state, EDITOR);
              break;
            }
            case "agent--help": {
              await page.evaluate(() => {
                const s = window.__visual.store.getState() as unknown as {
                  sidebarView: string;
                  setSidebarView(view: string): void;
                };
                if (s.sidebarView !== "connections") s.setSidebarView("connections");
              });
              await page.locator(id("agent-header-agent-edge")).click({ button: "right" });
              await page.locator(id("context-agent-setup")).click();
              await page.locator(id("password-prompt-input")).fill("secret");
              await page.locator(id("password-prompt-connect")).click();
              const local = page.locator(id("agent-setup-source-local"));
              await local.waitFor();
              await expect(page.locator(id("agent-setup-source-github-summary"))).toHaveText(
                "The released agent; the usual choice"
              );
              await local.focus();
              const help = page.locator(id("agent-setup-source-local-help"));
              await help.waitFor();
              await placed(help);
              await inWindow(help, "local file help");
              await shoot(page, state, "[role=dialog]");
              break;
            }
          }
        });
      }
    });
  }
}
