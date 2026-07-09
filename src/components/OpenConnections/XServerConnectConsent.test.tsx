/**
 * Tests for the connect-triggered X server consent dialog (#1116): a
 * `x-server-consent-needed` event opens the consent screen; Enable replies
 * `enable` to the paused connect and switches to progress; a `ready` progress
 * step closes the dialog; Not now replies `notNow` and closes without provisioning.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type {
  XServerConsentRequest,
  XServerError,
  XServerProgress,
  XServerStatusReport,
} from "@/types/xserver";

const xServerConnectConsentReply = vi.fn<(id: string, decision: string) => Promise<boolean>>();
const xServerEnsure = vi.fn<() => Promise<XServerStatusReport>>();
const xServerInstallDependency = vi.fn<() => Promise<void>>();

let consentCallback: ((req: XServerConsentRequest) => void) | undefined;
let progressCallback: ((p: XServerProgress) => void) | undefined;

vi.mock("@/services/api", () => ({
  xServerConnectConsentReply: (id: string, decision: string) =>
    xServerConnectConsentReply(id, decision),
  xServerEnsure: () => xServerEnsure(),
  xServerInstallDependency: () => xServerInstallDependency(),
}));

vi.mock("@/services/events", () => ({
  onXServerConsentNeeded: (cb: (req: XServerConsentRequest) => void) => {
    consentCallback = cb;
    return Promise.resolve(() => {});
  },
  onXServerProgress: (cb: (p: XServerProgress) => void) => {
    progressCallback = cb;
    return Promise.resolve(() => {});
  },
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: () => {} }));

import { XServerConnectConsent } from "./XServerConnectConsent";

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const REQUEST: XServerConsentRequest = { id: "abc-123", platform: "windows" };

describe("XServerConnectConsent", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    xServerConnectConsentReply.mockReset();
    xServerConnectConsentReply.mockResolvedValue(true);
    xServerEnsure.mockReset();
    xServerInstallDependency.mockReset();
    consentCallback = undefined;
    progressCallback = undefined;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render() {
    act(() => {
      root.render(React.createElement(XServerConnectConsent));
    });
  }

  function click(testId: string) {
    const el = document.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;
    if (!el) throw new Error(`missing element: ${testId}`);
    el.click();
  }

  function query(testId: string): Element | null {
    return document.querySelector(`[data-testid="${testId}"]`);
  }

  it("is closed until a consent-needed event arrives", async () => {
    render();
    await flush();
    expect(query("x-server-connect-consent-dialog")).toBeNull();
  });

  it("opens on the event, replies enable, provisions, and closes on ready", async () => {
    render();
    await flush();

    // Backend signals a connect paused for consent.
    act(() => consentCallback?.(REQUEST));
    await flush();
    expect(query("x-server-connect-consent-body")).not.toBeNull();

    // Enable → reply to the paused connect and switch to progress.
    await act(async () => {
      click("x-server-connect-consent-enable");
      await Promise.resolve();
    });
    await flush();
    expect(xServerConnectConsentReply).toHaveBeenCalledWith("abc-123", "enable");
    expect(query("x-server-connect-consent-progress")).not.toBeNull();

    // A terminal progress step from the backend closes the dialog.
    act(() => progressCallback?.({ step: "ready", message: "X server ready.", progress: 1 }));
    await flush();
    expect(query("x-server-connect-consent-dialog")).toBeNull();
  });

  it("replies notNow and closes when the user declines", async () => {
    render();
    await flush();
    act(() => consentCallback?.(REQUEST));
    await flush();

    click("x-server-connect-consent-not-now");
    await flush();

    expect(xServerConnectConsentReply).toHaveBeenCalledWith("abc-123", "notNow");
    expect(query("x-server-connect-consent-dialog")).toBeNull();
  });

  it("shows a recoverable error screen (not toast+close) on a failed step", async () => {
    render();
    await flush();
    act(() => consentCallback?.(REQUEST));
    await flush();

    await act(async () => {
      click("x-server-connect-consent-enable");
      await Promise.resolve();
    });
    await flush();

    // A failed terminal step surfaces the error screen instead of closing.
    act(() => progressCallback?.({ step: "failed", message: "Download failed.", progress: 1 }));
    await flush();

    expect(query("x-server-connect-consent-dialog")).not.toBeNull();
    expect(query("x-server-connect-consent-error")?.textContent).toContain("Download failed.");
    expect(query("x-server-connect-consent-retry")).not.toBeNull();
  });

  it("retries provisioning via x_server_ensure from the error screen", async () => {
    const ensure = deferred<XServerStatusReport>();
    xServerEnsure.mockReturnValue(ensure.promise);

    render();
    await flush();
    act(() => consentCallback?.(REQUEST));
    await flush();
    await act(async () => {
      click("x-server-connect-consent-enable");
      await Promise.resolve();
    });
    await flush();
    act(() => progressCallback?.({ step: "failed", message: "Download failed.", progress: 1 }));
    await flush();

    // Retry drives the frontend x_server_ensure provisioning path.
    await act(async () => {
      click("x-server-connect-consent-retry");
      await Promise.resolve();
    });
    await flush();
    expect(xServerEnsure).toHaveBeenCalledTimes(1);
    expect(query("x-server-connect-consent-progress")).not.toBeNull();

    const report: XServerStatusReport = {
      state: "running",
      platform: "windows",
      displayNumber: 0,
      managed: true,
      sessionCount: 0,
    };
    await act(async () => {
      ensure.resolve(report);
      await Promise.resolve();
    });
    await flush();
    expect(query("x-server-connect-consent-dialog")).toBeNull();
  });

  it("offers Install on a dependencyMissing ensure failure after retry", async () => {
    const ensure = deferred<XServerStatusReport>();
    xServerEnsure.mockReturnValue(ensure.promise);
    xServerInstallDependency.mockResolvedValue(undefined);

    render();
    await flush();
    act(() => consentCallback?.(REQUEST));
    await flush();
    await act(async () => {
      click("x-server-connect-consent-enable");
      await Promise.resolve();
    });
    await flush();
    act(() => progressCallback?.({ step: "failed", message: "Download failed.", progress: 1 }));
    await flush();

    await act(async () => {
      click("x-server-connect-consent-retry");
      await Promise.resolve();
    });
    await flush();

    const err: XServerError = {
      kind: "dependencyMissing",
      message: "XQuartz is not installed",
      dependency: "XQuartz",
      installHint: "Install XQuartz from xquartz.org",
      installCommand: "brew install --cask xquartz",
    };
    await act(async () => {
      ensure.reject(err);
      await Promise.resolve();
    });
    await flush();

    expect(query("x-server-connect-consent-error")?.textContent).toContain(
      "XQuartz is not installed"
    );
    const install = query("x-server-connect-consent-install-dep");
    expect(install).not.toBeNull();

    await act(async () => {
      click("x-server-connect-consent-install-dep");
      await Promise.resolve();
    });
    await flush();
    expect(xServerInstallDependency).toHaveBeenCalledTimes(1);
  });
});

/** A deferred promise whose resolve/reject can be triggered by the test. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
