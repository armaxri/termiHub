/**
 * #5068: the real, wired connect overlay in the booted app. A tab is opened
 * against a mock `create_connection` that never resolves (or rejects for the
 * failure hosts), the backend's `connect-progress` events are emitted through
 * the mocked event bus, and the overlay is screenshotted in Dark and Light for
 * Telnet connecting, SSH authenticating, failed and timed out.
 *
 * A second test turns reduced motion off and checks the ring's animations
 * actually run (`getAnimations()` playing, `currentTime` advancing) — the
 * "never looks frozen" guarantee, since neither animation waits on a JS timer.
 */

import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import type { VisualScenario } from "./harness/mockBackend";
import type { VisualHandle } from "./harness/visualHandle";
import { SCREENS } from "./surfaces";

declare global {
  interface Window {
    __visual: VisualHandle;
  }
}

const THEMES = ["dark", "light"] as const;
const OVERLAY =
  "[data-testid=terminal-connection-overlay]:not(.terminal-connection-overlay--hidden)";

test.use({ viewport: { width: 1100, height: 720 } });

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
}

async function boot(page: Page): Promise<void> {
  const scenario: VisualScenario = { connectOverlay: true };
  await page.addInitScript((s) => {
    window.__VISUAL_SCENARIO__ = s;
  }, scenario);
  await page.goto("/tests/visual/harness/index.html");
  await page.waitForFunction(() => window.__visual !== undefined);
  await page.locator("[data-testid=sidebar]").waitFor();
  await settle(page);
}

/** Open a terminal tab for `config` and wait for its connect to start. */
async function openTab(
  page: Page,
  title: string,
  config: { type: string; config: Record<string, unknown> }
): Promise<string> {
  const before = await page.evaluate(
    () => (window.__VISUAL_INVOKED__ ?? []).filter((c) => c === "create_connection").length
  );
  const tabId = await page.evaluate(
    ([t, c]) =>
      window.__visual.store.getState().addTab(t, c.type, c, { contentType: "terminal" }) as string,
    [title, config] as const
  );
  await page.waitForFunction(
    (n) => (window.__VISUAL_INVOKED__ ?? []).filter((c) => c === "create_connection").length > n,
    before
  );
  await page.locator(OVERLAY).waitFor();
  return tabId;
}

async function progress(page: Page, tabId: string, stage: string, status: string | null) {
  await page.evaluate(
    ([id, st, msg]) =>
      window.__visual.emit("connect-progress", { connectId: `${id}:0`, stage: st, status: msg }),
    [tabId, stage, status] as const
  );
}

async function shoot(page: Page, name: string, testInfo: { attach: Function }) {
  for (const theme of THEMES) {
    await page.evaluate((t) => window.__visual.applyTheme(t), theme);
    await settle(page);
    const file = join(SCREENS, "connect-overlay", `${name}-${theme}.png`);
    await page.locator(OVERLAY).screenshot({ path: file });
    await testInfo.attach(`connect overlay ${name} (${theme})`, {
      path: file,
      contentType: "image/png",
    });
  }
}

const stepStates = (page: Page) =>
  page
    .locator(`${OVERLAY} .ui-connect-progress__step`)
    .evaluateAll((els) => els.map((e) => `${e.textContent}:${(e as HTMLElement).dataset.state}`));

test("the wired connect overlay renders telnet, SSH, failed and timed-out in Dark and Light", async ({
  page,
}, testInfo) => {
  await boot(page);

  const telnet = await openTab(page, "192.168.0.42", {
    type: "telnet",
    config: { host: "192.168.0.42", port: 23 },
  });
  await progress(page, telnet, "connect", "TCP connect to 192.168.0.42:23");
  await expect
    .poll(() => stepStates(page))
    .toEqual(["Resolve:done", "Connect:active", "Session:pending"]);
  await expect(
    page.locator(`${OVERLAY} [data-testid=terminal-connection-abort-btn]`)
  ).toBeVisible();
  await expect(page.locator(`${OVERLAY} [data-testid=terminal-connection-cancel-btn]`)).toHaveCount(
    0
  );
  await shoot(page, "telnet-connecting", testInfo);

  const ssh = await openTab(page, "prod-db", {
    type: "ssh",
    config: {
      host: "db.internal",
      port: 22,
      username: "admin",
      proxyJump: [{ host: "bastion" }],
    },
  });
  await progress(
    page,
    ssh,
    "authenticate",
    "Trying public key ~/.ssh/id_ed25519 for admin@db.internal"
  );
  await expect
    .poll(() => stepStates(page))
    .toEqual([
      "Resolve:done",
      "Connect:done",
      "Host key:done",
      "Authenticate:active",
      "Shell:pending",
    ]);
  await shoot(page, "ssh-authenticating", testInfo);

  // From here on the connects fail: let the overlays leave Connecting.
  await page.evaluate(() => {
    window.__VISUAL_HOLD_CONNECT__ = false;
  });
  const failed = await openTab(page, "fail.example", {
    type: "ssh",
    config: { host: "fail.example", port: 22, username: "admin" },
  });
  await progress(page, failed, "authenticate", null);
  await expect(page.locator(`${OVERLAY} .ui-content-overlay__heading`)).toHaveText(
    "Connection failed"
  );
  await expect.poll(async () => (await stepStates(page))[3]).toBe("Authenticate:failed");
  await shoot(page, "failed", testInfo);

  await openTab(page, "timeout.example", {
    type: "telnet",
    config: { host: "timeout.example", port: 23 },
  });
  await expect(page.locator(`${OVERLAY} .ui-content-overlay__heading`)).toHaveText(
    "Timed out"
  );
  await shoot(page, "timed-out", testInfo);
});

test("the connect ring's animations run without any JS timer (full motion)", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await boot(page);
  await page.evaluate(() =>
    window.__visual.store.getState().addTab(
      "192.168.0.42",
      "telnet",
      { type: "telnet", config: { host: "192.168.0.42" } },
      {
        contentType: "terminal",
      }
    )
  );
  const comet = page.locator(`${OVERLAY} .ui-connect-progress__comet`);
  await comet.waitFor();

  const read = () =>
    page.locator(OVERLAY).evaluate((el) => {
      const anim = (sel: string) => el.querySelector(sel)?.getAnimations()[0];
      const c = anim(".ui-connect-progress__comet");
      const f = anim(".ui-connect-progress__ring-fill");
      return {
        comet: c?.playState,
        cometTime: Number(c?.currentTime ?? 0),
        fill: f?.playState,
        fillTime: Number(f?.currentTime ?? 0),
      };
    });

  const first = await read();
  expect(first.comet, "the comet orbits").toBe("running");
  expect(first.fill, "the timeout fill advances").toBe("running");
  await page.waitForTimeout(400);
  const second = await read();
  expect(second.cometTime).toBeGreaterThan(first.cometTime);
  expect(second.fillTime).toBeGreaterThan(first.fillTime);
});
