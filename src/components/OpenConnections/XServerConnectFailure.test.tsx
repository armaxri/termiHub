/**
 * Tests for the connect-time X server failure surface (#5079): an
 * `x-server-connect-failed` event (an X11-forwarding connect that could not get
 * a usable local X server, e.g. Wayland without XWayland) raises a toast that
 * carries the typed guidance, and its action opens the shared X server error
 * screen. When the connect-consent dialog is already driving that connect's
 * provisioning, the typed error goes into its error screen instead of a toast.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { XServerConsentRequest, XServerError, XServerProgress } from "@/types/xserver";

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/components/ui", async (importActual) => {
  const actual = await importActual<typeof import("@/components/ui")>();
  return {
    ...actual,
    toast: { ...actual.toast, error: toastError, success: toastSuccess },
  };
});

const xServerConnectConsentReply = vi.fn<(id: string, decision: string) => Promise<boolean>>();

vi.mock("@/services/api", () => ({
  xServerConnectConsentReply: (id: string, decision: string) =>
    xServerConnectConsentReply(id, decision),
  xServerEnsure: vi.fn(),
  xServerInstallDependency: vi.fn(),
}));

let consentCallback: ((req: XServerConsentRequest) => void) | undefined;
let progressCallback: ((p: XServerProgress) => void) | undefined;
let failedCallback: ((e: XServerError) => void) | undefined;

vi.mock("@/services/events", () => ({
  onXServerConsentNeeded: (cb: (req: XServerConsentRequest) => void) => {
    consentCallback = cb;
    return Promise.resolve(() => {});
  },
  onXServerProgress: (cb: (p: XServerProgress) => void) => {
    progressCallback = cb;
    return Promise.resolve(() => {});
  },
  onXServerConnectFailed: (cb: (e: XServerError) => void) => {
    failedCallback = cb;
    return Promise.resolve(() => {});
  },
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: () => {} }));

import {
  XServerConnectConsent,
  X_SERVER_CONNECT_FAILED_TOAST_ID,
  connectFailureToast,
} from "./XServerConnectConsent";

/** The typed Linux Wayland-gap error (types.rs `linux_xwayland_missing`). */
const XWAYLAND_MISSING: XServerError = {
  kind: "dependencyMissing",
  message:
    "This is a Wayland session without XWayland, so there is no X server for X11 forwarding to use.",
  dependency: "XWayland",
  installMode: "backend",
  installHint:
    "Install your distribution's XWayland package (e.g. `xwayland`, `xorg-xwayland`, or `xwayland` via your package manager), then reconnect.",
};

const HEADLESS: XServerError = {
  kind: "noLocalServer",
  message: "No local display was found — this looks like a headless system.",
};

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

describe("connectFailureToast", () => {
  it("puts the install hint in the description and names the install action", () => {
    const copy = connectFailureToast(XWAYLAND_MISSING);
    expect(copy.title).toBe("X11 forwarding unavailable");
    expect(copy.description).toContain("Wayland session without XWayland");
    expect(copy.description).toContain("XWayland package");
    expect(copy.actionLabel).toBe("Install XWayland…");
  });

  it("uses the plain message and a details action for other failures", () => {
    const copy = connectFailureToast(HEADLESS);
    expect(copy.description).toBe(HEADLESS.message);
    expect(copy.actionLabel).toBe("Show details");
  });
});

describe("XServerConnectConsent connect failures (#5079)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    toastError.mockReset();
    toastSuccess.mockReset();
    xServerConnectConsentReply.mockReset();
    xServerConnectConsentReply.mockResolvedValue(true);
    consentCallback = undefined;
    progressCallback = undefined;
    failedCallback = undefined;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render() {
    act(() => {
      root.render(React.createElement(XServerConnectConsent));
    });
    await flush();
  }

  it("raises one toast carrying the XWayland hint without opening a dialog", async () => {
    await render();

    act(() => failedCallback?.(XWAYLAND_MISSING));
    await flush();

    expect(toastError).toHaveBeenCalledTimes(1);
    const [title, opts] = toastError.mock.calls[0];
    expect(title).toBe("X11 forwarding unavailable");
    expect(opts).toMatchObject({
      id: X_SERVER_CONNECT_FAILED_TOAST_ID,
      testId: "x-server-connect-failed-toast",
      action: { label: "Install XWayland…" },
    });
    expect(opts.description).toContain("XWayland package");
    expect(query("x-server-connect-consent-dialog")).toBeNull();
  });

  it("reuses one toast id so repeated failing connects do not stack", async () => {
    await render();

    act(() => failedCallback?.(XWAYLAND_MISSING));
    act(() => failedCallback?.(XWAYLAND_MISSING));
    await flush();

    const ids = toastError.mock.calls.map(([, opts]) => opts.id);
    expect(new Set(ids)).toEqual(new Set([X_SERVER_CONNECT_FAILED_TOAST_ID]));
  });

  it("opens the shared error screen with the install action from the toast", async () => {
    await render();
    act(() => failedCallback?.(XWAYLAND_MISSING));
    await flush();

    const { action } = toastError.mock.calls[0][1];
    act(() => action.onClick());
    await flush();

    expect(query("x-server-connect-consent-dialog")).not.toBeNull();
    expect(query("x-server-connect-consent-error")?.textContent).toContain(
      "Wayland session without XWayland"
    );
    expect(query("x-server-connect-consent-dialog")?.textContent).toContain("XWayland package");
    expect(query("x-server-connect-consent-install-dep")?.textContent).toContain(
      "Install XWayland"
    );
    // Nothing was paused waiting on a consent reply.
    expect(xServerConnectConsentReply).not.toHaveBeenCalled();

    act(() => query("x-server-connect-consent-close")?.click());
    await flush();
    expect(query("x-server-connect-consent-dialog")).toBeNull();
  });

  it("folds the typed error into an open provisioning dialog instead of toasting", async () => {
    await render();

    act(() => consentCallback?.({ id: "req-1", platform: "windows" }));
    await flush();
    await act(async () => {
      query("x-server-connect-consent-enable")?.click();
      await Promise.resolve();
    });
    await flush();
    expect(query("x-server-connect-consent-progress")).not.toBeNull();

    // The resumed connect fails: the untyped progress step, then the typed event.
    act(() => {
      progressCallback?.({ step: "failed", message: XWAYLAND_MISSING.message, progress: 1 });
      failedCallback?.(XWAYLAND_MISSING);
    });
    await flush();

    expect(toastError).not.toHaveBeenCalled();
    expect(query("x-server-connect-consent-install-dep")?.textContent).toContain(
      "Install XWayland"
    );
    expect(query("x-server-connect-consent-dialog")?.textContent).toContain("XWayland package");
  });

  it("still toasts a failure that arrives while another connect awaits consent", async () => {
    await render();
    act(() => consentCallback?.({ id: "req-2", platform: "windows" }));
    await flush();

    act(() => failedCallback?.(HEADLESS));
    await flush();

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(query("x-server-connect-consent-body")).not.toBeNull();
  });
});
