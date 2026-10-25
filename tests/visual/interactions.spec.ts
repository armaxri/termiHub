/**
 * Real-pointer, real-keyboard and stacking checks (#4949).
 *
 * Three sub-steps of retired guided prompts need input the in-app test bridge
 * cannot fake: a synthetic `pointerover` never sets CSS `:hover`, and a
 * synthetic Tab `keydown` never moves focus (the browser does that, not a
 * handler). Playwright drives Chromium's real input pipeline, so these run
 * here, against the real frontend and the in-browser IPC mock:
 *
 * - MT-UI-41 — the terminal's scrollbar thumb brightens while the pointer is
 *   over it, returns when it leaves, and nothing shifts in between;
 * - MT-UI-47 — Tab and Shift+Tab inside the zoom overlay never reach the
 *   panels behind it;
 * - MT-UI-48 — the refresh-interval menu of an SSH host monitor opens above
 *   the Open Connections dialog, and picking an interval dispatches it.
 *
 * The rest of each item is graded on the built app in the integration lane
 * (tests/system/tests/test_theme_grades.py, test_layout_grades.py).
 */

import { expect, test, type Page } from "@playwright/test";

import { MONITOR_KEY, VISUAL_SESSION_ID, type VisualScenario } from "./harness/mockBackend";

type StoreState = Record<string, (...args: unknown[]) => unknown> & Record<string, unknown>;
declare global {
  interface Window {
    __visual: {
      store: { getState(): StoreState };
      emit(event: string, payload: unknown): Promise<void>;
      applyTheme(setting: string): void;
    };
  }
}

/** Built-in themes MT-UI-41 sweeps. */
const THEMES = ["dark", "light", "solarized-dark", "solarized-light"] as const;

const THUMB = ".terminal-vscroll-thumb";
const ZOOM = "[data-testid=zoom-overlay]";

/** Wait for React to commit and the browser to lay out the change. */
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

/**
 * Open a local terminal tab whose session is the mock's, and fill it with
 * enough output to have scrollback (so the gutter thumb shows). Returns the tab id.
 */
async function terminalWithScrollback(page: Page): Promise<string> {
  const tabId = await page.evaluate(
    () =>
      window.__visual.store
        .getState()
        .addTab("Visual", "local", { type: "local", config: {} }, { contentType: "terminal" }) as string
  );
  await page.waitForFunction(() => window.__VISUAL_INVOKED__?.includes("create_connection"));
  await page.locator(THUMB).waitFor({ state: "attached" });
  const lines = Array.from({ length: 300 }, (_, i) => `scrollback line ${i + 1}\r\n`).join("");
  // Emit until the thumb shows: the session's output listener attaches just
  // after `create_connection` resolves, so the first emit can land before it.
  await expect
    .poll(
      async () => {
        await page.evaluate(
          ([session, data]) =>
            window.__visual.emit("terminal-output", { session_id: session, data: btoa(data) }),
          [VISUAL_SESSION_ID, lines] as const
        );
        return page.locator(THUMB).evaluate((el) => (el as HTMLElement).style.display);
      },
      { message: "the scrollbar thumb to show over scrollback", timeout: 15_000 }
    )
    .toBe("block");
  return tabId;
}

/** What MT-UI-41 reads off the thumb: its colour against the pane, and the layout. */
interface ThumbReading {
  /** WCAG contrast of the thumb (alpha-composited) against the pane background. */
  contrast: number;
  color: string;
  /** Thumb, gutter and text-screen rects, rounded to 0.1px. */
  rects: number[][];
}

function readThumb(page: Page): Promise<ThumbReading> {
  return page.locator(THUMB).evaluate((thumb) => {
    type Rgba = [number, number, number, number];
    const parse = (c: string): Rgba => {
      const n = (c.match(/[\d.]+/g) ?? []).map(Number);
      return [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0, n.length > 3 ? n[3] : 1];
    };
    const bgOf = (el: Element | null): Rgba => {
      for (let node = el; node; node = node.parentElement) {
        const c = parse(getComputedStyle(node).backgroundColor);
        if (c[3] > 0) return c;
      }
      return [0, 0, 0, 1];
    };
    const lum = ([r, g, b]: Rgba): number => {
      const ch = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
    };
    const color = getComputedStyle(thumb).backgroundColor;
    const fg = parse(color);
    const bg = bgOf(thumb.parentElement);
    const a = fg[3];
    const mixed: Rgba = [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)) as unknown as Rgba;
    mixed[3] = 1;
    const [l1, l2] = [lum(mixed), lum(bg)].sort((x, y) => y - x);
    const rect = (el: Element | null) => {
      const r = el?.getBoundingClientRect();
      return r ? [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 10) / 10) : [];
    };
    const container = thumb.closest(".terminal-container") ?? thumb.parentElement?.parentElement;
    return {
      contrast: (l1 + 0.05) / (l2 + 0.05),
      color,
      rects: [
        rect(thumb),
        rect(thumb.parentElement),
        rect(container?.querySelector(".xterm-screen") ?? null),
      ],
    };
  });
}

/** The thumb once its colour has settled (the theme switch and hover fade it). */
async function restingThumb(page: Page): Promise<ThumbReading> {
  let last = "";
  await expect
    .poll(async () => {
      const color = (await readThumb(page)).color;
      const stable = color === last;
      last = color;
      await page.waitForTimeout(150);
      return stable;
    })
    .toBe(true);
  return readThumb(page);
}

/** Move the pointer to a corner far from the terminal's gutter. */
async function pointerAway(page: Page): Promise<void> {
  await page.mouse.move(2, 2, { steps: 3 });
}

/** The nearest `data-testid` of the focused element, and whether it is inside `root`. */
function focusInside(page: Page, root: string): Promise<{ inside: boolean; where: string }> {
  return page.evaluate((sel) => {
    const el = document.activeElement;
    const tagged = el?.closest("[data-testid]");
    const where = tagged?.getAttribute("data-testid") ?? el?.tagName.toLowerCase() ?? "none";
    return { inside: !!el && !!document.querySelector(sel)?.contains(el), where };
  }, root);
}

test.use({ viewport: { width: 1280, height: 800 } });

test("MT-UI-41: the terminal thumb brightens on hover, returns, and nothing shifts", async ({
  page,
}) => {
  await boot(page, { terminal: true });
  await terminalWithScrollback(page);
  for (const theme of THEMES) {
    await page.evaluate((t) => window.__visual.applyTheme(t), theme);
    await pointerAway(page);
    const rest = await restingThumb(page);
    await page.locator(THUMB).hover();
    // The colour transitions (--transition-fast); wait for it to settle brighter.
    await expect
      .poll(async () => (await readThumb(page)).contrast, {
        message: `${theme}: the thumb brightens under the pointer (rest ${rest.contrast.toFixed(2)}:1)`,
      })
      .toBeGreaterThan(rest.contrast + 0.05);
    await expect.poll(async () => (await readThumb(page)).color).not.toBe(rest.color);
    const hovered = await readThumb(page);
    expect(hovered.rects, `${theme}: hovering moved or resized the thumb or text`).toEqual(
      rest.rects
    );
    await pointerAway(page);
    await expect
      .poll(async () => (await readThumb(page)).color, {
        message: `${theme}: the thumb returns to its rest colour`,
      })
      .toBe(rest.color);
    expect((await readThumb(page)).rects, `${theme}: leaving shifted the layout`).toEqual(
      rest.rects
    );
  }
});

test("MT-UI-47: Tab and Shift+Tab never leave the zoom overlay", async ({ page }) => {
  await boot(page, { terminal: true });
  const tabId = await terminalWithScrollback(page);
  await page.evaluate((id) => window.__visual.store.getState().setZoomedTabId(id), tabId);
  await page.locator(ZOOM).waitFor();
  await settle(page);
  // Something focusable behind the overlay exists, so leaking focus is possible.
  const behind = await page.evaluate(
    (sel) =>
      Array.from(
        document.querySelectorAll<HTMLElement>("button, [tabindex='0'], input, a[href]")
      ).filter((el) => !document.querySelector(sel)?.contains(el) && el.offsetParent !== null)
        .length,
    ZOOM
  );
  expect(behind, "focusable controls behind the overlay").toBeGreaterThan(0);
  // A focused terminal keeps Tab for its program, so start from the header.
  await page.locator(`${ZOOM} button`).first().focus();
  for (const shift of [false, true]) {
    const key = shift ? "Shift+Tab" : "Tab";
    for (let i = 0; i < 8; i++) {
      // Back to the header whenever focus reaches the terminal (it eats Tab).
      const terminalFocused = await page.evaluate(
        () => !!document.activeElement?.closest(".xterm")
      );
      if (terminalFocused) await page.locator(`${ZOOM} button`).first().focus();
      await page.keyboard.press(key);
      const focus = await focusInside(page, ZOOM);
      expect(focus.inside, `${key} #${i + 1} moved focus behind the overlay to ${focus.where}`).toBe(
        true
      );
    }
  }
  await expect(page.locator(ZOOM)).toBeVisible();
});

test("MT-UI-48: the refresh-interval menu opens above Open Connections", async ({ page }) => {
  await boot(page, { monitoring: true });
  await page.locator("[data-testid=activity-bar-settings]").click();
  await page.locator("[data-testid=settings-menu-open-connections]").click();
  const trigger = page.locator(`[data-testid="monitor-interval-${MONITOR_KEY}"]`);
  await trigger.waitFor();
  await expect(trigger).toContainText("2s");
  await trigger.click();
  const option = page.locator(`[data-testid="monitor-interval-${MONITOR_KEY}-5000"]`);
  await option.waitFor();
  // Every menu item is the topmost element at its own centre: nothing of the
  // dialog (or its scrim) paints over the menu.
  const covered = await page.evaluate((key) => {
    const items = document.querySelectorAll<HTMLElement>(
      `[data-testid^="monitor-interval-${key}-"]`
    );
    const bad: string[] = [];
    for (const item of items) {
      const r = item.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!top || !item.contains(top)) {
        const at = top?.closest("[data-testid]")?.getAttribute("data-testid") ?? top?.className;
        bad.push(`${item.dataset.testid} under ${String(at)}`);
      }
    }
    return { count: items.length, bad };
  }, MONITOR_KEY);
  expect(covered.count, "refresh-interval options rendered").toBeGreaterThan(1);
  expect(covered.bad, "refresh-interval options covered by the dialog").toEqual([]);
  const before = (await page.evaluate(() => window.__VISUAL_INVOKED__ ?? [])).length;
  await option.click();
  await expect(option).toHaveCount(0);
  const invoked = (await page.evaluate(() => window.__VISUAL_INVOKED__ ?? [])).slice(before);
  expect(invoked.some((c) => c.startsWith("intent_dispatch:monitor")), invoked.join(", ")).toBe(
    true
  );
  // The dialog stays open: the pick closed only the menu.
  await expect(trigger).toBeVisible();
});
