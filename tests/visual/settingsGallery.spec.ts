/**
 * #5860: Settings grouped by object, at the minimum window and the usual one, in
 * dark and light, for a usability review by someone who did not build it.
 *
 * Run `pnpm exec playwright test -c tests/visual/playwright.config.ts settingsGallery`.
 * The shots land in `test-results/screens/settings-grouping/`, named
 * `<surface>--<state>--<window>--<theme>.png`, with `index.json` beside them: what the
 * user wants to do in each, so a reviewer grades a situation and not a picture.
 * Every shot is also audited for layout, so a broken state fails here.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import type { VisualScenario } from "./harness/mockBackend";
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
const DIR = join(SCREENS, "settings-grouping");
const WINDOWS = [
  { width: 800, height: 600 },
  { width: 1280, height: 800 },
];
const THEMES = ["dark", "light"];
const id = (testId: string) => `[data-testid="${testId}"]`;
const PANEL = id("settings-panel");
const KEYCHAIN: VisualScenario = { credentialStore: { mode: "os_keychain", status: "unlocked" } };

/** Every state, and what the user wants to do there. */
const STATES = {
  "nav--general": "Find a setting by browsing: which group holds what?",
  "nav--advanced-open": "Find the X server or portable mode, folded under Advanced.",
  "general--plugins": "Turn plugins on or manage them, found by browsing under General.",
  "general--open-in-termihub": "Add termiHub to the file manager's menu.",
  "connections--defaults":
    "Set the user and key a new SSH connection starts with, X11 forwarding, and the file browser.",
  "connections--monitoring": "Choose what is monitored on the hosts one connects to.",
  "connections--serial": "Set which serial ports are offered.",
  "connections--external-files": "Keep connections in a file shared with others.",
  "automation--schedules": "Find where the scheduled runs are and what they do.",
  "automation--schedules-opened": "Open schedules was chosen: the list, next to its automations.",
  "security--password-backup":
    "Back up the passwords saved in the OS Keychain: where does that happen?",
  "security--password-backup-off": "Passwords are not saved: is there anything to back up?",
  "data--backup": "Back up everything, or restore passwords from an older termiHub's export.",
  "data--import": "Bring connections over from another tool once.",
  "search--old-name": "Search by the old name 'vault': find where backing up passwords went.",
  "search--ssh-default": "Search 'default user': find the SSH default where it lives now.",
} as const;
type State = keyof typeof STATES;

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
}

/** Boot the app and open Settings on `category`. */
async function boot(
  page: Page,
  theme: string,
  category: string,
  scenario: VisualScenario = {}
): Promise<void> {
  await page.addInitScript(
    (s) => {
      window.__VISUAL_SCENARIO__ = s;
    },
    { populated: true, ...scenario }
  );
  await page.goto("/tests/visual/harness/index.html");
  await page.waitForFunction(() => window.__visual !== undefined);
  await page.locator(id("sidebar")).waitFor();
  await page.evaluate(
    async ([t, cat]) => {
      const state = window.__visual.store.getState() as unknown as {
        loadSchedules(): Promise<void>;
        loadCredentialStoreStatus?: () => Promise<void>;
        openSettingsTab(target: { category: string }): void;
      };
      await state.loadSchedules();
      await state.loadCredentialStoreStatus?.();
      window.__visual.applyTheme(t);
      state.openSettingsTab({ category: cat });
    },
    [theme, category] as const
  );
  await page.locator(PANEL).waitFor();
  await expect(page.locator(".settings-panel__lazy-fallback")).toHaveCount(0);
}

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

for (const viewport of WINDOWS) {
  for (const theme of THEMES) {
    const where = `${viewport.width}x${viewport.height}--${theme}`;

    test.describe(`settings grouping gallery ${where}`, () => {
      test.use({ viewport, timezoneId: "UTC", locale: "en-US" });

      /** Screenshot a state and audit the Settings panel's layout. */
      async function shot(page: Page, state: State, root = PANEL): Promise<void> {
        await page.mouse.move(viewport.width - 2, viewport.height / 2);
        await settle(page);
        const path = join(DIR, `${state}--${where}.png`);
        await page.screenshot({ path });
        await test.info().attach(state, { path, contentType: "image/png" });
        const issues = await page.evaluate(auditLayout, { root, styledClasses: STYLED_CLASSES });
        expect.soft(issues, state).toEqual([]);
      }

      /** Open a category from the nav, as a user would. */
      async function open(page: Page, category: string): Promise<void> {
        await page.locator(id(`settings-nav-${category}`)).click();
        await expect(page.locator(id(`settings-nav-${category}`))).toHaveAttribute(
          "aria-selected",
          "true"
        );
      }

      test("nav", async ({ page }) => {
        await boot(page, theme, "general");
        await shot(page, "nav--general");
        const toggle = page.locator(id("settings-navgroup-advanced-toggle"));
        if (await toggle.isVisible()) await toggle.click();
        await open(page, "x-server");
        await shot(page, "nav--advanced-open");
      });

      test("general", async ({ page }) => {
        await boot(page, theme, "plugins");
        await shot(page, "general--plugins");
        await open(page, "shell-integration");
        await shot(page, "general--open-in-termihub");
      });

      test("connections", async ({ page }) => {
        await boot(page, theme, "connection-defaults");
        await page.locator(id("connection-defaults-settings")).waitFor();
        await shot(page, "connections--defaults");
        for (const [category, state] of [
          ["monitoring", "connections--monitoring"],
          ["serial", "connections--serial"],
          ["external-files", "connections--external-files"],
        ] as const) {
          await open(page, category);
          await shot(page, state);
        }
      });

      test("automation", async ({ page }) => {
        await boot(page, theme, "schedules");
        await page.locator(id("schedules-settings-summary")).waitFor();
        await shot(page, "automation--schedules");
        await page.locator(id("schedules-settings-open")).click();
        await page.locator(id("schedules-section")).waitFor();
        await shot(page, "automation--schedules-opened", "body");
      });

      test("security and data", async ({ page }) => {
        await boot(page, theme, "security", KEYCHAIN);
        const section = page.locator(id("password-backup"));
        await expect(page.locator(id("password-backup-open"))).toBeVisible();
        await section.scrollIntoViewIfNeeded();
        await shot(page, "security--password-backup");
        await page.locator(id("password-backup-open")).click();
        await page.locator(id("older-password-import")).waitFor();
        await shot(page, "data--backup");
        await open(page, "import");
        await shot(page, "data--import");
      });

      test("security, passwords not saved", async ({ page }) => {
        await boot(page, theme, "security");
        const section = page.locator(id("password-backup"));
        await expect(page.locator(id("password-backup-unavailable"))).toBeVisible();
        await section.scrollIntoViewIfNeeded();
        await shot(page, "security--password-backup-off");
      });

      test("search", async ({ page }) => {
        await boot(page, theme, "general", KEYCHAIN);
        const search = page.locator(`${PANEL} [aria-label="Search settings"]`);
        await search.fill("vault");
        await page.locator(id("password-backup")).waitFor();
        await shot(page, "search--old-name");
        await search.fill("default user");
        await page.locator(id("settings-default-user")).waitFor();
        await shot(page, "search--ssh-default");
      });
    });
  }
}
