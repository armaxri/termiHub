/**
 * #5081: every connect attempt — the first, a retry after Abort, a retry after
 * a timeout and a retry after a failure — shows a fresh ring that fills and
 * ends in a final state. Before the fix, Abort and the client deadline did not
 * end the attempt (its connect kept running and the session-lifecycle region
 * stayed `connecting`), so the overlay showed "Connecting…" forever with an
 * emptied ring.
 *
 * Runs the real app against the connect-overlay mock: `create_connection`
 * hangs until `cancel_connecting` names its connect id (or rejects for
 * `fail.example`). Playwright's clock drives the 90 s client deadline.
 */

import { expect, test, type Page } from "@playwright/test";

import type { VisualScenario } from "./harness/mockBackend";
import type { VisualHandle } from "./harness/visualHandle";

declare global {
  interface Window {
    __visual: VisualHandle;
  }
}

const OVERLAY =
  "[data-testid=terminal-connection-overlay]:not(.terminal-connection-overlay--hidden)";
const RING_CIRCUMFERENCE = 2 * Math.PI * 28;

test.use({ viewport: { width: 1100, height: 720 } });

async function boot(page: Page): Promise<void> {
  await page.clock.install();
  const scenario: VisualScenario = { connectOverlay: true };
  await page.addInitScript((s) => {
    window.__VISUAL_SCENARIO__ = s;
  }, scenario);
  await page.goto("/tests/visual/harness/index.html");
  await page.waitForFunction(() => window.__visual !== undefined);
  await page.locator("[data-testid=sidebar]").waitFor();
}

async function openTelnet(page: Page, host: string): Promise<string> {
  const tabId = await page.evaluate(
    (h) =>
      window.__visual.store.getState().addTab(
        h,
        "telnet",
        { type: "telnet", config: { host: h, port: 23 } },
        {
          contentType: "terminal",
        }
      ) as string,
    host
  );
  await page.locator(OVERLAY).waitFor();
  return tabId;
}

const heading = (page: Page) => page.locator(`${OVERLAY} .ui-content-overlay__heading`);

/** The ring's filled fraction (0..1), read off the fill's computed dash offset. */
async function ringProgress(page: Page): Promise<number> {
  const offset = await page
    .locator(`${OVERLAY} .ui-connect-progress__ring-fill`)
    .evaluate((el) => parseFloat(getComputedStyle(el).strokeDashoffset));
  return 1 - offset / RING_CIRCUMFERENCE;
}

/** Sample the ring twice, 3 s apart on the page clock: it must be filling. */
async function expectRingFilling(page: Page, what: string): Promise<void> {
  const first = await ringProgress(page);
  await page.clock.runFor(3_000);
  await expect
    .poll(() => ringProgress(page), { message: `${what}: the ring keeps filling` })
    .toBeGreaterThan(first + 0.01);
}

const cancelled = (page: Page) => page.evaluate(() => window.__VISUAL_CANCELLED_CONNECTS__ ?? []);

test("Abort, Retry and the timeout each end in a final state with a fresh, filling ring", async ({
  page,
}) => {
  await boot(page);
  const tabId = await openTelnet(page, "10.255.255.1");

  // First attempt: connecting, ring filling.
  await expect(heading(page)).toHaveText("Connecting to 10.255.255.1");
  await expectRingFilling(page, "first attempt");

  // Abort ends the attempt: its connect is cancelled and the overlay settles.
  await page.locator(`${OVERLAY} [data-testid=terminal-connection-abort-btn]`).click();
  await expect(heading(page)).toHaveText("Connection aborted");
  expect(await cancelled(page)).toContain(`${tabId}:0`);

  // Retry after Abort: a fresh ring (near empty), filling again.
  await page.locator(`${OVERLAY} [data-testid=terminal-connection-retry-btn]`).click();
  await expect(heading(page)).toHaveText("Connecting to 10.255.255.1");
  expect(await ringProgress(page)).toBeLessThan(0.05);
  await expectRingFilling(page, "retry after Abort");

  // The retry reaches its client deadline and ends in a final state.
  await page.clock.runFor(90_000);
  await expect(heading(page)).toHaveText("Timed out");
  expect(await cancelled(page)).toContain(`${tabId}:1`);

  // Retry after the timeout: again a fresh ring that fills.
  await page.locator(`${OVERLAY} [data-testid=terminal-connection-retry-btn]`).click();
  await expect(heading(page)).toHaveText("Connecting to 10.255.255.1");
  expect(await ringProgress(page)).toBeLessThan(0.05);
  await expectRingFilling(page, "retry after timeout");
});

test("a retry after a failure fails again instead of connecting forever", async ({ page }) => {
  await boot(page);
  await openTelnet(page, "fail.example");
  await expect(heading(page)).toHaveText("Connection failed");

  for (let i = 0; i < 2; i++) {
    await page.locator(`${OVERLAY} [data-testid=terminal-connection-retry-btn]`).click();
    await expect(heading(page), `retry ${i + 1} settles`).toHaveText("Connection failed");
  }
});
