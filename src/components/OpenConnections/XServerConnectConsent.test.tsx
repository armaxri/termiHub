/**
 * Tests for the connect-triggered X server consent dialog (#1116): a
 * `x-server-consent-needed` event opens the consent screen; Enable replies
 * `enable` to the paused connect and switches to progress; a `ready` progress
 * step closes the dialog; Not now replies `notNow` and closes without provisioning.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { XServerConsentRequest, XServerProgress } from "@/types/xserver";

const xServerConnectConsentReply = vi.fn<(id: string, decision: string) => Promise<boolean>>();

let consentCallback: ((req: XServerConsentRequest) => void) | undefined;
let progressCallback: ((p: XServerProgress) => void) | undefined;

vi.mock("@/services/api", () => ({
  xServerConnectConsentReply: (id: string, decision: string) =>
    xServerConnectConsentReply(id, decision),
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
});
