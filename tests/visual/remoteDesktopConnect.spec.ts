/**
 * #6062: an RDP tab follows what really happened while it connects: connecting
 * while the helper dials, signing in once the host answered, and a failure with
 * its reason. Never "Connected" before the server accepted the logon.
 *
 * The connect resolves at once (the helper started); the backend's
 * `remote-desktop-state` events are emitted through the mocked event bus.
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

const SESSION = "rd-visual";
const THEMES = ["dark", "light"] as const;

test.use({ viewport: { width: 1100, height: 720 } });

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
}

async function openRdpTab(page: Page): Promise<void> {
  const scenario: VisualScenario = {
    answers: {
      remote_desktop_connect: SESSION,
      // RDP offers no file side channel (#4348).
      remote_desktop_file_channel: { status: "notOffered" },
    },
  };
  await page.addInitScript((s) => {
    window.__VISUAL_SCENARIO__ = s;
  }, scenario);
  await page.goto("/tests/visual/harness/index.html");
  await page.waitForFunction(() => window.__visual !== undefined);
  await page.locator("[data-testid=sidebar]").waitFor();
  await page.evaluate(() => {
    const config = { type: "rdp", config: { host: "desk.example", port: 3389, username: "ana" } };
    window.__visual.store
      .getState()
      .addTab("desk.example", "rdp", config, { contentType: "remote-desktop" });
  });
  await page.waitForFunction(() =>
    (window.__VISUAL_INVOKED__ ?? []).includes("remote_desktop_connect")
  );
}

async function state(page: Page, payload: Record<string, unknown>): Promise<void> {
  await page.evaluate(
    ([id, p]) =>
      window.__visual.emit("remote-desktop-state", {
        session_id: id,
        reconnect_attempt: 0,
        ...p,
      }),
    [SESSION, payload] as const
  );
  await settle(page);
}

async function shoot(page: Page, name: string, testId: string): Promise<void> {
  const overlay = page.locator(`[data-testid=${testId}]`);
  await overlay.waitFor();
  // The busy body fades in after 250 ms: capture it once it is fully there.
  await expect
    .poll(() =>
      overlay.evaluate((el) =>
        [el, ...el.querySelectorAll("*")].every(
          (n) =>
            Number(getComputedStyle(n).opacity) === 1 &&
            n
              .getAnimations()
              .every(
                (a) =>
                  a.playState === "finished" ||
                  (a.playState === "running" &&
                    (a as CSSAnimation).animationName !== "ui-cp-appear")
              )
        )
      )
    )
    .toBe(true);
  for (const theme of THEMES) {
    await page.evaluate((t) => window.__visual.applyTheme(t), theme);
    await settle(page);
    await overlay.screenshot({ path: join(SCREENS, "remote-desktop", `${name}-${theme}.png`) });
  }
}

test("an RDP tab says what the helper is doing until the server accepted the logon", async ({
  page,
}) => {
  await openRdpTab(page);
  await state(page, { state: "connecting" });
  const connecting = page.locator("[data-testid=remote-desktop-overlay-connecting]");
  await expect(connecting).toContainText("Connecting to desk.example");
  await expect(page.locator("[data-testid=remote-desktop-overlay-first-frame]")).toHaveCount(0);
  await shoot(page, "connecting", "remote-desktop-overlay-connecting");

  await state(page, { state: "authenticating" });
  await expect(connecting).toContainText("Signing in to desk.example");
  await expect(page.locator("[data-testid=remote-desktop-overlay-first-frame]")).toHaveCount(0);
  await shoot(page, "signing-in", "remote-desktop-overlay-connecting");

  await state(page, {
    state: "authFailed",
    code: "auth_failed",
    message: "The server rejected the user name or password.",
  });
  await expect(page.locator("[data-testid=remote-desktop-overlay-connecting]")).toHaveCount(0);
  await expect(page.locator("[data-testid=remote-desktop-overlay-first-frame]")).toHaveCount(0);
  await shoot(page, "logon-rejected", "remote-desktop-overlay-error");
});

test("a helper that never gets there fails as timed out, with what to check", async ({ page }) => {
  await openRdpTab(page);
  await state(page, { state: "connecting" });
  await state(page, {
    state: "connectFailed",
    code: "timeout",
    message:
      "Connection to desk.example timed out after 60s while the remote desktop helper connected and signed in.",
  });
  const error = page.locator("[data-testid=remote-desktop-overlay-error]");
  await expect(error).toContainText("timed out");
  await shoot(page, "timed-out", "remote-desktop-overlay-error");
});
