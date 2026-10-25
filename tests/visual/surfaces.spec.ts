/**
 * Rendered visual checks (#4712).
 *
 * Boots the real frontend against the in-browser IPC mock at three window sizes
 * and audits the surfaces user testing found broken (#4708–#4711): every
 * Settings category on a fresh start, every sidebar at its default and minimum
 * width, and the main dialogs. The assertions need no baseline images (see
 * layoutAudit.ts); every surface is also screenshotted for human review.
 *
 * These surfaces replaced guided-manual release checks (#4928): MT-CRED-17
 * (unlock and password dialog spacing), MT-UI-54 (Settings rows styled on a
 * fresh start, also at a narrow Settings tab), MT-UI-55 (Settings section
 * headers at the minimum window and on one row when wide) and the look of
 * MT-UI-56 (imported workspace confirmations at every window size); and since
 * #4954 MT-UI-53 (sidebar rows at the default and minimum width: cut names keep
 * a tooltip, row actions show on hover and focus, overflow items act like
 * their buttons). The layout rules they assert live in expectations.ts.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { allowedBy, ALLOWLIST, type AllowEntry } from "./allowlist";
import type { VisualScenario } from "./harness/mockBackend";
import type { VisualHandle } from "./harness/visualHandle";
import { STORED_SECRET_CONNECTIONS } from "./harness/storedSecretIds";
import {
  cutNames,
  oneRowHeaderIssues,
  rowActionIssues,
  settingsFieldIssues,
  stackedGapIssues,
} from "./expectations";
import { auditLayout, type LayoutIssue } from "./layoutAudit";
import {
  SCREENS,
  SIDEBAR_ROWS,
  SIDEBAR_WIDTHS,
  SIDEBARS,
  STORE_DIALOGS,
  USAGE_DIR,
  WINDOWS,
  type SidebarRowKind,
} from "./surfaces";
import { styledPrimitiveClasses } from "./uiClasses";

const STYLED_CLASSES = styledPrimitiveClasses();

declare global {
  interface Window {
    /** What the harness exposes (see harness/boot.ts). */
    __visual: VisualHandle;
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

/** The open Settings category panel. */
const SETTINGS_PANEL = ".settings-panel:not(.settings-panel--hidden)";

/** The window wide enough for a Settings section header to fit on one row. */
const WIDEST = WINDOWS[0].name;

/** Open a Settings category and wait until its lazy chunk has rendered. */
async function openSettings(page: Page, category: string): Promise<void> {
  await store(page, "openSettingsTab", { category });
  await page.locator(SETTINGS_PANEL).waitFor();
  await expect(page.locator(".settings-panel__lazy-fallback")).toHaveCount(0);
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

/** The minimum sidebar width the resize handle allows. */
async function sidebarMinWidth(page: Page): Promise<number> {
  const min = Number(
    await page.locator("[data-testid=sidebar-resize-handle]").getAttribute("aria-valuemin")
  );
  expect(min, "sidebar resize handle exposes its minimum").toBeGreaterThan(0);
  return min;
}

/** Move the pointer off the sidebar, drop keyboard focus, and wait for tooltips to close. */
async function rest(page: Page): Promise<void> {
  const size = page.viewportSize() ?? { width: 800, height: 600 };
  // In steps, like a real pointer: Radix keeps a tooltip open while the
  // pointer could still be heading for it, and closes once a move leaves.
  await page.mouse.move(size.width - 1, size.height - 1, { steps: 4 });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(page.locator("[role=tooltip]")).toHaveCount(0);
}

/**
 * MT-UI-53 (#4954): every cut name of one row kind exposes its full text — as
 * a native `title`, or as the tooltip that hovering the start of the name opens.
 */
async function cutNameIssues(
  page: Page,
  kind: SidebarRowKind,
  requireCut: boolean
): Promise<LayoutIssue[]> {
  const rows = `[data-testid=sidebar] ${kind.row}`;
  const cut = await page.evaluate(cutNames, { rows, name: kind.name });
  const issues: LayoutIssue[] = [];
  if (requireCut && cut.length === 0) {
    issues.push({
      kind: "expectation",
      where: `${kind.kind} rows`,
      detail: "no name is cut at this width, so the tooltip check saw nothing (seed a longer one)",
    });
  }
  for (const { index, text } of cut.filter((c) => !c.titled)) {
    const where = `${kind.kind} row "${text.slice(0, 40)}"`;
    const name = page.locator(rows).nth(index).locator(kind.name).first();
    // Hover the start of the name: on hover the row's actions overlay its end.
    const box = await name.boundingBox();
    const y = (box?.height ?? 16) / 2;
    const reached = await name
      .hover({ position: { x: 4, y }, timeout: 2000 })
      .then(() => true)
      .catch(() => false);
    if (!reached || !box) {
      issues.push({
        kind: "expectation",
        where,
        detail: "the start of the cut name cannot be hovered (covered on hover)",
      });
      await rest(page);
      continue;
    }
    // The first pointer contact arms TruncatedText; Radix opens on the next move.
    await page.mouse.move(box.x + 8, box.y + y);
    const shown = await page
      .locator("[role=tooltip]")
      .filter({ hasText: text })
      .first()
      .waitFor({ state: "attached", timeout: 2000 })
      .then(() => true)
      .catch(() => false);
    if (!shown) {
      issues.push({
        kind: "expectation",
        where,
        detail: "the name is cut but neither a title nor a hover tooltip shows the full text",
      });
    }
    await rest(page);
  }
  return issues;
}

/**
 * MT-UI-53 (#4954): hovering a row, and keyboard focus on it, shows its actions
 * unclipped. Checks every row of the kind (each state has its own action set).
 */
async function rowRevealIssues(page: Page, kind: SidebarRowKind): Promise<LayoutIssue[]> {
  const rows = page.locator(`[data-testid=sidebar] ${kind.row}`);
  const count = await rows.count();
  if (count === 0) {
    return [{ kind: "expectation", where: `${kind.kind} rows`, detail: "no row rendered" }];
  }
  const issues: LayoutIssue[] = [];
  const args = { row: "[data-visual-row]", actions: kind.actions };
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    await row.evaluate((el) => {
      for (const n of document.querySelectorAll("[data-visual-row]")) {
        n.removeAttribute("data-visual-row");
      }
      el.setAttribute("data-visual-row", "");
    });
    await row.hover({ position: { x: 4, y: 4 } });
    await settle(page);
    issues.push(...(await page.evaluate(rowActionIssues, { ...args, via: "hover" })));
    await rest(page);
    // Keyboard focus: the row itself when it is in the tab order (roving
    // tabindex), else its first focusable part.
    await row.evaluate((el) => {
      const target = el.matches("[tabindex]")
        ? el
        : el.querySelector<HTMLElement>("[tabindex], button, a[href]");
      (target as HTMLElement | null)?.focus();
    });
    await settle(page);
    issues.push(...(await page.evaluate(rowActionIssues, { ...args, via: "focus" })));
    await rest(page);
  }
  return issues;
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
        await openSettings(page, category);
        // MT-UI-54: rows keep their label/control/hint layout; MT-UI-55: when
        // the window is wide, each section header keeps title and buttons on one row.
        const extra = await page.evaluate(settingsFieldIssues, SETTINGS_PANEL);
        if (win.name === WIDEST)
          extra.push(...(await page.evaluate(oneRowHeaderIssues, SETTINGS_PANEL)));
        await report.check(`settings/${category}`, SETTINGS_PANEL, extra);
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
      const minWidth = await sidebarMinWidth(page);
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

    test("sidebar rows keep cut names readable and show actions on hover and focus", async ({
      page,
    }, testInfo) => {
      // MT-UI-53 (#4954): on every seeded row kind, at the default and the
      // minimum sidebar width.
      const report = new SurfaceReport(page, testInfo, win.name);
      await boot(page);
      const minWidth = await sidebarMinWidth(page);
      for (const kind of SIDEBAR_ROWS) {
        await showSidebar(page, kind.view);
        for (const width of SIDEBAR_WIDTHS) {
          const min = width.width === "aria-valuemin";
          await store(page, "setSidebarWidth", min ? minWidth : width.width);
          await settle(page);
          await rest(page);
          const extra = [
            ...(await cutNameIssues(page, kind, min)),
            ...(await rowRevealIssues(page, kind)),
          ];
          await report.check(`rows/${kind.kind}@${width.name}`, "[data-testid=sidebar]", extra);
        }
      }
      await report.finish();
    });

    test("unlock dialog", async ({ page }, testInfo) => {
      const report = new SurfaceReport(page, testInfo, win.name);
      await boot(page, { credentialStore: { mode: "master_password", status: "locked" } });
      await store(page, "setUnlockDialogOpen", true);
      await page.getByRole("dialog").waitFor();
      // MT-CRED-17: description, field, error and reset link are separate lines
      // with a clear gap; the audit's text-overlap check covers the focus ring.
      const order = {
        testIds: [
          "unlock-dialog-description",
          "unlock-dialog-field",
          "unlock-dialog-error",
          "unlock-dialog-forgot",
        ],
        minGap: 4,
      };
      const input = page.locator("[data-testid=unlock-dialog-input]");
      await input.focus();
      await report.check(
        "dialog/unlock",
        "[role=dialog]",
        await page.evaluate(stackedGapIssues, order)
      );
      // A wrong password (the mock rejects every unlock) adds the error line.
      await input.fill("not-the-master-password");
      await page.locator("[data-testid=unlock-dialog-unlock]").click();
      await page.locator("[data-testid=unlock-dialog-error]").waitFor();
      await input.focus();
      await report.check(
        "dialog/unlock-wrong-password",
        "[role=dialog]",
        await page.evaluate(stackedGapIssues, order)
      );
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
      const appearance = page.locator("[data-testid=mobaxterm-import-appearance]");
      await appearance.scrollIntoViewIfNeeded();
      await report.check("dialog/mobaxterm-import-appearance", "[role=dialog]");
      await report.finish();
    });

    test("settings section header actions and the create-file prompt", async ({
      page,
    }, testInfo) => {
      // MT-UI-55: at 800x600 the header buttons wrap below the title and stay
      // usable (the audit flags a clipped control), and Create File opens a
      // prompt whose field stays usable.
      const report = new SurfaceReport(page, testInfo, win.name);
      await boot(page);
      await openSettings(page, "external-files");
      await page.getByRole("button", { name: "Create File" }).click();
      await page.locator(".settings-panel__create-prompt").waitFor();
      await report.check("settings/external-files-create-prompt", SETTINGS_PANEL);
      await report.finish();
    });

    for (const { name, action, args } of STORE_DIALOGS) {
      test(`${name} dialog`, async ({ page }, testInfo) => {
        const report = new SurfaceReport(page, testInfo, win.name);
        await boot(page);
        await store(page, action, ...args);
        await page.getByRole("dialog").first().waitFor();
        // MT-CRED-17: the SSH password prompt keeps the same gap above its field.
        const extra =
          name === "password-prompt"
            ? await page.evaluate(stackedGapIssues, {
                testIds: [
                  "password-prompt-notice",
                  "password-prompt-description",
                  "password-prompt-input",
                ],
                minGap: 4,
              })
            : [];
        await report.check(`dialog/${name}`, "[role=dialog]", extra);
        await report.finish();
      });
    }
  });
}

/** One toolbar action as rendered inline: its accessible name and form. */
interface InlineToolbarAction {
  label: string;
  /** Opens a drop-down instead of acting (a sub-menu in the overflow menu). */
  menu: boolean;
  disabled: boolean;
}

/** The inline actions of every width-responsive toolbar in the sidebar, in order. */
async function inlineToolbarActions(page: Page): Promise<InlineToolbarAction[][]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("[data-testid=sidebar] .ui-toolbar")].map((bar) =>
      [
        ...bar.querySelectorAll<HTMLButtonElement>(":scope > button:not(.ui-toolbar__overflow)"),
      ].map((b) => ({
        label: b.getAttribute("aria-label") ?? "",
        menu: b.getAttribute("aria-haspopup") === "menu",
        disabled: b.disabled,
      }))
    )
  );
}

/** The `index`-th toolbar of the sidebar. */
function toolbar(page: Page, index: number) {
  return page.locator("[data-testid=sidebar] .ui-toolbar").nth(index);
}

/**
 * Commands the app sends on its own timer, not because of an action: the
 * services poll and the debounced settings save after a sidebar resize.
 */
const BACKGROUND_COMMANDS = ["record_frontend_log", "get_embedded_server_states", "save_settings"];

/**
 * What an action visibly did: the IPC commands it sent (intents by kind), the
 * tabs and active tab, open dialogs, toasts, the sidebar view, and the items
 * of the last menu it opened.
 */
async function actionEffect(page: Page, since: number): Promise<unknown> {
  await settle(page);
  await page.waitForTimeout(300);
  return page.evaluate(
    ([mark, background]) => {
      const text = (el: Element) => (el.textContent ?? "").trim().replace(/\s+/g, " ");
      const menus = [...document.querySelectorAll("[role=menu]")];
      const state = window.__visual.store.getState() as unknown as { sidebarView: string };
      return {
        ipc: (window.__VISUAL_INVOKED__ ?? []).slice(mark).filter((c) => !background.includes(c)),
        tabs: [...document.querySelectorAll(".tab:not(.tab--drag-overlay)")].map(text),
        active: [...document.querySelectorAll(".tab--active")].map(text),
        dialogs: [...document.querySelectorAll("[role=dialog], [role=alertdialog]")].map(
          (d) =>
            d.getAttribute("aria-label") ?? text(d.querySelector("h1, h2, h3") ?? d).slice(0, 60)
        ),
        toasts: [...document.querySelectorAll("[data-sonner-toast]")].map(text),
        sidebarView: state.sidebarView,
        menu: menus.length
          ? [...menus[menus.length - 1].querySelectorAll("[role=menuitem]")].map(text)
          : [],
      };
    },
    [since, BACKGROUND_COMMANDS] as const
  );
}

/** How many IPC commands the app has sent so far. */
async function invokedCount(page: Page): Promise<number> {
  return page.evaluate(() => (window.__VISUAL_INVOKED__ ?? []).length);
}

/** Fresh app with `view` open at `width`. */
async function bootSidebar(page: Page, view: string, width: number | "min"): Promise<void> {
  await boot(page);
  await showSidebar(page, view);
  await store(page, "setSidebarWidth", width === "min" ? await sidebarMinWidth(page) : width);
  await settle(page);
}

/** A sidebar width at which every toolbar shows all its actions labelled. */
const WIDE_SIDEBAR = 560;

test.describe("sidebar overflow menus", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  for (const view of SIDEBARS) {
    test(`${view}: overflow items do what their toolbar buttons do`, async ({ page }) => {
      // MT-UI-53 (#4954): at the minimum width every action a toolbar shows
      // at a wide width is still reachable (inline or in the "…" menu), and
      // each overflow item has the same effect as its button. Each trigger
      // runs on a freshly booted app so the two effects are comparable.
      test.setTimeout(300_000);
      await bootSidebar(page, view, WIDE_SIDEBAR);
      const wide = await inlineToolbarActions(page);
      await store(page, "setSidebarWidth", await sidebarMinWidth(page));
      await settle(page);
      const narrow = await inlineToolbarActions(page);
      expect(narrow.length, "same toolbars at both widths").toBe(wide.length);

      const overflowed: Array<{ bar: number; action: InlineToolbarAction }> = [];
      for (let bar = 0; bar < wide.length; bar++) {
        const trigger = toolbar(page, bar).locator(":scope > .ui-toolbar__overflow");
        if ((await trigger.count()) === 0) {
          expect(narrow[bar], `toolbar ${bar} keeps every action inline`).toEqual(wide[bar]);
          continue;
        }
        await trigger.click();
        const items = await page
          .locator("[role=menu]")
          .last()
          .locator(":scope [role=menuitem]")
          .allInnerTexts();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("menu")).toHaveCount(0);
        const inline = new Set(narrow[bar].map((a) => a.label));
        for (const action of wide[bar]) {
          if (inline.has(action.label)) continue;
          expect
            .soft(
              items.map((t) => t.trim()),
              `toolbar ${bar}: "${action.label}" is in the overflow menu`
            )
            .toContain(action.label);
          if (!action.disabled) overflowed.push({ bar, action });
        }
      }
      test.info().annotations.push({
        type: "info",
        description: `${overflowed.length} overflowed action(s) compared`,
      });

      for (const { bar, action } of overflowed) {
        await bootSidebar(page, view, WIDE_SIDEBAR);
        let mark = await invokedCount(page);
        await toolbar(page, bar)
          .locator(":scope > button", { hasNot: page.locator(".ui-toolbar__overflow") })
          .and(page.getByRole("button", { name: action.label, exact: true }))
          .click({ timeout: 10_000 });
        const viaButton = await actionEffect(page, mark);

        await bootSidebar(page, view, "min");
        await toolbar(page, bar)
          .locator(":scope > .ui-toolbar__overflow")
          .click({ timeout: 10_000 });
        mark = await invokedCount(page);
        const item = page
          .locator("[role=menu]")
          .last()
          .getByRole("menuitem", { name: action.label, exact: true });
        // A drop-down action is a sub-menu here: opening it is its effect.
        if (action.menu) await item.press("ArrowRight", { timeout: 10_000 });
        else await item.click({ timeout: 10_000 });
        const viaMenu = await actionEffect(page, mark);
        expect.soft(viaMenu, `"${action.label}" from the overflow menu`).toEqual(viaButton);
      }
    });
  }
});

/** The Settings tab width MT-UI-54 narrows to. */
const NARROW_SETTINGS = 420;

test.describe("narrow settings tab", () => {
  test.use({ viewport: { width: 1024, height: 700 } });

  test("general and sessions settings at a narrow settings tab", async ({ page }, testInfo) => {
    // MT-UI-54: widen the sidebar until the Settings tab is ~420px wide, then
    // the General and Sessions rows must keep their layout without clipping.
    const report = new SurfaceReport(page, testInfo, "narrow-settings");
    await boot(page);
    await openSettings(page, "general");
    const tab = page.locator(".settings-panel").first();
    const sidebar = page.locator("[data-testid=sidebar]");
    const tabWidth = (await tab.boundingBox())?.width ?? 0;
    const sidebarWidth = (await sidebar.boundingBox())?.width ?? 0;
    await store(page, "setSidebarWidth", Math.round(sidebarWidth + tabWidth - NARROW_SETTINGS));
    await settle(page);
    const narrowed = (await tab.boundingBox())?.width ?? 0;
    expect(Math.abs(narrowed - NARROW_SETTINGS), `settings tab is ${narrowed}px wide`).toBeLessThan(
      20
    );
    for (const category of ["general", "sessions"]) {
      await openSettings(page, category);
      await report.check(
        `settings/${category}@narrow`,
        SETTINGS_PANEL,
        await page.evaluate(settingsFieldIssues, SETTINGS_PANEL)
      );
    }
    await report.finish();
  });
});
