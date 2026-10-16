/**
 * Rendered visual checks (#4712).
 *
 * Boots the real frontend against the in-browser IPC mock at three window sizes
 * and audits the surfaces user testing found broken (#4708–#4711): every
 * Settings category on a fresh start, every sidebar at its default and minimum
 * width, and the main dialogs. The assertions need no baseline images (see
 * layoutAudit.ts); every surface is also screenshotted for human review.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { allowedBy, ALLOWLIST, type AllowEntry } from "./allowlist";
import type { VisualScenario } from "./harness/mockBackend";
import { STORED_SECRET_CONNECTIONS } from "./harness/storedSecretIds";
import { auditLayout, type LayoutIssue } from "./layoutAudit";
import { SCREENS, SIDEBAR_WIDTHS, SIDEBARS, STORE_DIALOGS, USAGE_DIR, WINDOWS } from "./surfaces";
import { styledPrimitiveClasses } from "./uiClasses";

const STYLED_CLASSES = styledPrimitiveClasses();

/** The app store the harness exposes (see harness/boot.ts). */
type StoreState = Record<string, (...args: unknown[]) => unknown>;
declare global {
  interface Window {
    __visual: { store: { getState(): StoreState } };
  }
}

/**
 * Audits the surfaces of one test. Each surface is its own soft assertion, so
 * one broken surface (or a later timeout) never hides the others' results.
 */
class SurfaceReport {
  private readonly consoleErrors: string[] = [];
  private readonly used = new Set<AllowEntry>();

  constructor(
    private readonly page: Page,
    private readonly testInfo: TestInfo,
    private readonly windowName: string
  ) {
    page.on("console", (msg) => {
      if (msg.type() === "error") this.consoleErrors.push(msg.text().split("\n")[0]);
    });
    page.on("pageerror", (err) => this.consoleErrors.push(`uncaught: ${err.message}`));
  }

  /** Audit one surface, screenshot it, and soft-fail on anything not allowlisted. */
  async check(surface: string, root: string, extra: LayoutIssue[] = []): Promise<void> {
    await settle(this.page);
    const found = await this.page.evaluate(auditLayout, { root, styledClasses: STYLED_CLASSES });
    const consoleIssues = this.consoleErrors
      .splice(0)
      .map((text): LayoutIssue => ({ kind: "console-error", where: "console", detail: text }));
    const unexpected: string[] = [];
    for (const issue of [...found, ...extra, ...consoleIssues]) {
      const entry = allowedBy(surface, issue);
      if (entry) this.used.add(entry);
      else unexpected.push(`[${issue.kind}] ${issue.where} — ${issue.detail}`);
    }
    const file = join(SCREENS, this.windowName, `${surface.replace(/[/@]/g, "_")}.png`);
    await this.page.screenshot({ path: file });
    await this.testInfo.attach(surface, { path: file, contentType: "image/png" });
    expect
      .soft(unexpected, `${surface} @ ${this.windowName}:\n  ${unexpected.join("\n  ")}`)
      .toEqual([]);
  }

  /**
   * Record which allowlist entries this test used (globalTeardown warns about
   * entries no test used) and note IPC commands the mock left unanswered.
   */
  async finish(): Promise<void> {
    mkdirSync(USAGE_DIR, { recursive: true });
    writeFileSync(
      join(USAGE_DIR, `${this.testInfo.testId}.json`),
      JSON.stringify([...this.used].map((entry) => ALLOWLIST.indexOf(entry)))
    );
    const unhandled = await this.page.evaluate(() => [...new Set(window.__VISUAL_UNHANDLED__)]);
    if (unhandled.length > 0) {
      this.testInfo.annotations.push({
        type: "info",
        description: `IPC commands answered with the null fallback: ${unhandled.join(", ")}`,
      });
    }
  }
}

/** The connection editor of the active tab (inactive editor tabs are `display: none`). */
const VISIBLE_EDITOR = '.connection-editor:not([style*="display: none"])';

/** Wait for React to commit and the browser to lay out the change. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  await page.waitForTimeout(200);
}

/** Load the harness with a scenario and wait until the app shell is up. */
async function boot(page: Page, scenario: VisualScenario = {}): Promise<void> {
  await page.addInitScript((s) => {
    window.__VISUAL_SCENARIO__ = s;
  }, scenario);
  await page.goto("/tests/visual/harness/index.html");
  await page.waitForFunction(() => window.__visual !== undefined);
  await page.locator("[data-testid=sidebar]").waitFor();
  await settle(page);
}

/** Call an app-store action by name (the harness exposes the store). */
async function store(page: Page, action: string, ...args: unknown[]): Promise<void> {
  await page.evaluate(
    ([name, rest]) => {
      void window.__visual.store.getState()[name as string](...(rest as unknown[]));
    },
    [action, args] as const
  );
}

/** Show a sidebar view. `setSidebarView` on the current view would collapse it. */
async function showSidebar(page: Page, view: string): Promise<void> {
  await page.evaluate((v) => {
    const state = window.__visual.store.getState() as unknown as {
      sidebarView: string;
      sidebarCollapsed: boolean;
      setSidebarView(view: string): void;
    };
    if (state.sidebarView !== v || state.sidebarCollapsed) state.setSidebarView(v);
  }, view);
  await page.locator("[data-testid=sidebar]").waitFor();
}

for (const win of WINDOWS) {
  test.describe(`window ${win.name}`, () => {
    test.use({ viewport: { width: win.width, height: win.height } });

    test("settings categories render styled on a fresh start", async ({ page }, testInfo) => {
      const report = new SurfaceReport(page, testInfo, win.name);
      await boot(page);
      // Fresh start: Settings is the first thing opened — no connection editor
      // (and so none of its lazily loaded CSS) has been loaded yet (#4708).
      // The categories come from the rendered nav, so a new one is covered as
      // soon as it exists.
      await store(page, "openSettingsTab");
      const nav = page.locator(".settings-nav [data-testid^=settings-nav-]");
      await nav.first().waitFor();
      const categories = (
        await nav.evaluateAll((items) =>
          items.map((item) => item.getAttribute("data-testid") ?? "")
        )
      ).map((testId) => testId.replace("settings-nav-", ""));
      expect(categories.length, "settings nav lists its categories").toBeGreaterThan(10);
      for (const category of categories) {
        await store(page, "openSettingsTab", { category });
        await page.locator(".settings-panel:not(.settings-panel--hidden)").waitFor();
        await expect(page.locator(".settings-panel__lazy-fallback")).toHaveCount(0);
        await report.check(`settings/${category}`, ".settings-panel:not(.settings-panel--hidden)");
      }
      await report.finish();
    });

    test("security settings with imported workspace confirmations", async ({ page }, testInfo) => {
      const report = new SurfaceReport(page, testInfo, win.name);
      await boot(page, { importConfirmations: true });
      await store(page, "openSettingsTab", { category: "security" });
      const section = page.locator("[data-testid=imported-confirmations]");
      await section.scrollIntoViewIfNeeded();
      // Wait until the keys are matched against the saved workspace (#4445).
      await page.locator("[data-testid=imported-confirmations-group-ws-test]").waitFor();
      await page.locator("[data-testid=imported-confirmations-group-unused]").waitFor();
      await section.scrollIntoViewIfNeeded();
      await report.check(
        "settings/security-imported-confirmations",
        ".settings-panel:not(.settings-panel--hidden)"
      );
      await page.locator("[data-testid=imported-confirmations-revoke-all]").click();
      await page.getByRole("dialog").waitFor();
      await report.check("dialog/revoke-imported-confirmations", "[role=dialog]");
      await report.finish();
    });

    test("sidebars fit at default and minimum width", async ({ page }, testInfo) => {
      const report = new SurfaceReport(page, testInfo, win.name);
      await boot(page);
      const minWidth = Number(
        await page.locator("[data-testid=sidebar-resize-handle]").getAttribute("aria-valuemin")
      );
      expect(minWidth, "sidebar resize handle exposes its minimum").toBeGreaterThan(0);
      for (const view of SIDEBARS) {
        await showSidebar(page, view);
        for (const width of SIDEBAR_WIDTHS) {
          await store(
            page,
            "setSidebarWidth",
            width.width === "aria-valuemin" ? minWidth : width.width
          );
          await report.check(`sidebar/${view}@${width.name}`, "[data-testid=sidebar]");
          // A collapsed toolbar shows its primary action plus one "…" menu
          // (#4824): open the first one so the screenshot shows what it holds.
          const overflow = page.locator("[data-testid=sidebar] .ui-toolbar__overflow").first();
          if (width.width === "aria-valuemin" && (await overflow.isVisible())) {
            await overflow.click();
            await page.getByRole("menu").waitFor();
            await report.check(`sidebar/${view}@${width.name}-overflow-menu`, "[role=menu]");
            await page.keyboard.press("Escape");
            await expect(page.getByRole("menu")).toHaveCount(0);
            // Leave no hover/focus ring on the trigger for the next screenshot.
            await page.mouse.move(win.width - 1, win.height - 1);
            await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          }
        }
      }
      await report.finish();
    });

    test("unlock dialog", async ({ page }, testInfo) => {
      const report = new SurfaceReport(page, testInfo, win.name);
      await boot(page, { credentialStore: { mode: "master_password", status: "locked" } });
      await store(page, "setUnlockDialogOpen", true);
      await page.getByRole("dialog").waitFor();
      await report.check("dialog/unlock", "[role=dialog]");
      await report.finish();
    });

    test("keyboard shortcuts overlay", async ({ page }, testInfo) => {
      const report = new SurfaceReport(page, testInfo, win.name);
      await boot(page);
      await store(page, "setShortcutsOverlayOpen", true);
      await page.getByRole("dialog").waitFor();
      // The platform is known locally, so the overlay lists ONE shortcut column
      // (#4711): an "Action" column plus the running platform's bindings.
      const headers = await page.getByRole("dialog").locator("thead th").allInnerTexts();
      const extra: LayoutIssue[] =
        headers.length === 2
          ? []
          : [
              {
                kind: "expectation",
                where: "shortcuts table header",
                detail: `expected Action + one shortcut column, got [${headers.join(", ")}]`,
              },
            ];
      await report.check("dialog/shortcuts", "[role=dialog]", extra);
      await report.finish();
    });

    test("connection editor with stored secrets", async ({ page }, testInfo) => {
      const report = new SurfaceReport(page, testInfo, win.name);
      await boot(page, {
        storedSecrets: true,
        credentialStore: { mode: "master_password", status: "unlocked" },
      });
      // A plugin connection with two stored schema secrets: one kept ("saved"
      // placeholder + Clear), one marked for removal ("removed on save" + Undo).
      await store(page, "openConnectionEditorTab", STORED_SECRET_CONNECTIONS.plugin);
      const editor = page.locator(VISIBLE_EDITOR);
      await editor.locator("[data-testid=field-apiToken-secret-saved]").waitFor();
      await editor.locator("[data-testid=field-signingSecret-secret-clear]").click();
      await editor.locator("[data-testid=field-signingSecret-secret-cleared]").waitFor();
      await report.check("editor/stored-field-secret", VISIBLE_EDITOR);

      // An SSH connection whose inline jump-host hop password is stored.
      await store(page, "openConnectionEditorTab", STORED_SECRET_CONNECTIONS.hop);
      const hopSecret = page.locator(
        `${VISIBLE_EDITOR} [data-testid=jump-host-password-0-secret-saved]`
      );
      await hopSecret.waitFor();
      await hopSecret.scrollIntoViewIfNeeded();
      await report.check("editor/stored-hop-secret", VISIBLE_EDITOR);
      await report.finish();
    });

    test("plugin update dialog with an access diff", async ({ page }, testInfo) => {
      const report = new SurfaceReport(page, testInfo, win.name);
      await boot(page, { pluginUpdate: true });
      await showSidebar(page, "plugins");
      // The real install-from-file flow: picker → preview → trust → dialog.
      await page.locator("[data-testid=plugin-install-from-file]").click();
      await page.locator("[data-testid=plugin-install-access-more]").waitFor();
      // The "Validating plugin…" toast is dismissed once the preview is in,
      // even though the mocked preview answers at once (#4812).
      await page.getByText("Validating plugin…").waitFor({ state: "hidden" });
      await report.check("dialog/plugin-update-access-diff", "[role=dialog]");
      // The secondary list of access the update no longer requests.
      const removed = page.locator("[data-testid=plugin-install-access-removed]");
      await removed.scrollIntoViewIfNeeded();
      await report.check("dialog/plugin-update-access-diff-removed", "[role=dialog]");
      await report.finish();
    });

    test("mobaxterm import from settings", async ({ page }, testInfo) => {
      const report = new SurfaceReport(page, testInfo, win.name);
      await boot(page, { mobaxtermImport: true });
      // The real flow: Settings → Import & Migration (with the discovery hint)
      // → Import from MobaXterm… → preview of the found file (#4850).
      await store(page, "openSettingsTab", { category: "import" });
      const hint = page.locator("[data-testid=import-migration-mobaxterm-hint]");
      await hint.getByText("Found MobaXterm configuration at").waitFor();
      await report.check(
        "settings/import-mobaxterm-found",
        ".settings-panel:not(.settings-panel--hidden)"
      );
      await page.locator("[data-testid=import-migration-mobaxterm-btn]").click();
      await page.locator("[data-testid=mobaxterm-import-list]").waitFor();
      await report.check("dialog/mobaxterm-import", "[role=dialog]");
      const skipped = page.locator("[data-testid=mobaxterm-import-skipped]");
      await skipped.scrollIntoViewIfNeeded();
      await report.check("dialog/mobaxterm-import-skipped", "[role=dialog]");
      await report.finish();
    });

    for (const { name, action, args } of STORE_DIALOGS) {
      test(`${name} dialog`, async ({ page }, testInfo) => {
        const report = new SurfaceReport(page, testInfo, win.name);
        await boot(page);
        await store(page, action, ...args);
        await page.getByRole("dialog").first().waitFor();
        await report.check(`dialog/${name}`, "[role=dialog]");
        await report.finish();
      });
    }
  });
}
