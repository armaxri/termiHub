/**
 * #5079: the connect-time "X11 forwarding unavailable" toast in the booted app.
 * The backend's `x-server-connect-failed` event (a Wayland-only Linux session
 * without XWayland) is emitted through the mocked event bus; the toast must show
 * the XWayland install hint without opening anything, and its action must open
 * the shared X server error screen. Both are screenshotted in Dark and Light.
 */

import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import type { VisualHandle } from "./harness/visualHandle";
import { SCREENS } from "./surfaces";

declare global {
  interface Window {
    __visual: VisualHandle;
  }
}

const THEMES = ["dark", "light"] as const;
const TOAST = "[data-testid=x-server-connect-failed-toast]";
const DIALOG = "[data-testid=x-server-connect-consent-dialog]";

/** The typed Linux Wayland-gap error (types.rs `linux_xwayland_missing`). */
const XWAYLAND_MISSING = {
  kind: "dependencyMissing",
  message:
    "This is a Wayland session without XWayland, so there is no X server for X11 forwarding to use.",
  dependency: "XWayland",
  installMode: "backend",
  installHint:
    "Install your distribution's XWayland package (e.g. `xwayland`, `xorg-xwayland`, or `xwayland` via your package manager), then reconnect.",
};

test.use({ viewport: { width: 1100, height: 720 } });

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
}

async function shoot(
  page: Page,
  target: Locator,
  name: string,
  testInfo: { attach: Function }
): Promise<void> {
  for (const theme of THEMES) {
    await page.evaluate((t) => window.__visual.applyTheme(t), theme);
    await settle(page);
    await expect(target).toBeVisible();
    const file = join(SCREENS, "x-server-connect-failure", `${name}-${theme}.png`);
    await target.screenshot({ path: file, animations: "disabled" });
    await testInfo.attach(`x server connect failure ${name} (${theme})`, {
      path: file,
      contentType: "image/png",
    });
  }
}

test("a failed X11 connect shows the XWayland hint and opens the error screen", async ({
  page,
}, testInfo) => {
  await page.goto("/tests/visual/harness/index.html");
  await page.waitForFunction(() => window.__visual !== undefined);
  await page.locator("[data-testid=sidebar]").waitFor();
  await settle(page);

  await page.evaluate(
    (payload) => window.__visual.emit("x-server-connect-failed", payload),
    XWAYLAND_MISSING
  );

  const toast = page.locator(TOAST);
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("X11 forwarding unavailable");
  await expect(toast).toContainText("XWayland package");
  await expect(page.locator(DIALOG)).toHaveCount(0);
  await shoot(page, toast, "toast", testInfo);

  await toast.getByRole("button", { name: "Install XWayland…" }).click();
  const dialog = page.locator(DIALOG);
  await expect(dialog).toBeVisible();
  await expect(page.locator("[data-testid=x-server-connect-consent-error]")).toContainText(
    "Wayland session without XWayland"
  );
  await expect(page.locator("[data-testid=x-server-connect-consent-install-dep]")).toHaveText(
    "Install XWayland"
  );
  await shoot(page, dialog, "details", testInfo);
});
