/**
 * Tests for the X server setup / provisioning dialog (#1053): consent → Enable
 * runs x_server_ensure and shows progress → resolve calls onProvisioned and
 * closes; a dependencyMissing rejection surfaces an Install action; a plain
 * rejection surfaces the message with a Retry action.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { XServerError, XServerStatusReport } from "@/types/xserver";

const xServerEnsure = vi.fn<() => Promise<XServerStatusReport>>();
const xServerInstallDependency = vi.fn<() => Promise<void>>();
const onXServerProgress = vi.fn(() => Promise.resolve(() => {}));

vi.mock("@/services/api", () => ({
  xServerEnsure: () => xServerEnsure(),
  xServerInstallDependency: () => xServerInstallDependency(),
}));

vi.mock("@/services/events", () => ({
  onXServerProgress: () => onXServerProgress(),
}));

import { XServerSetupDialog } from "./XServerSetupDialog";

/** Flush pending microtasks (the async subscribe + ensure chain) inside act. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

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

describe("XServerSetupDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    xServerEnsure.mockReset();
    xServerInstallDependency.mockReset();
    onXServerProgress.mockClear();
    onXServerProgress.mockImplementation(() => Promise.resolve(() => {}));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderDialog(props: {
    onOpenChange?: (open: boolean) => void;
    onProvisioned?: (report: XServerStatusReport) => void;
  }) {
    act(() => {
      root.render(
        React.createElement(XServerSetupDialog, {
          open: true,
          onOpenChange: props.onOpenChange ?? (() => {}),
          onProvisioned: props.onProvisioned,
        })
      );
    });
  }

  function click(testId: string) {
    const el = document.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;
    if (!el) throw new Error(`missing element: ${testId}`);
    el.click();
  }

  it("shows consent, runs ensure on Enable, then provisions and closes", async () => {
    const ensure = deferred<XServerStatusReport>();
    xServerEnsure.mockReturnValue(ensure.promise);
    const onOpenChange = vi.fn();
    const onProvisioned = vi.fn();

    renderDialog({ onOpenChange, onProvisioned });

    // Consent screen is visible; nothing provisioned yet.
    expect(document.querySelector('[data-testid="x-server-setup-consent"]')).not.toBeNull();
    expect(xServerEnsure).not.toHaveBeenCalled();

    await act(async () => {
      click("x-server-setup-enable");
      await Promise.resolve();
    });
    await flush();

    // Provisioning: ensure was called and the progress bar is shown.
    expect(xServerEnsure).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="x-server-setup-progress"]')).not.toBeNull();

    const report: XServerStatusReport = {
      state: "running",
      platform: "windows",
      displayNumber: 0,
      managed: true,
    };
    await act(async () => {
      ensure.resolve(report);
      await Promise.resolve();
    });
    await flush();

    expect(onProvisioned).toHaveBeenCalledWith(report);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("surfaces an Install action on a dependencyMissing failure", async () => {
    const ensure = deferred<XServerStatusReport>();
    xServerEnsure.mockReturnValue(ensure.promise);
    xServerInstallDependency.mockResolvedValue(undefined);

    renderDialog({});

    await act(async () => {
      click("x-server-setup-enable");
      await Promise.resolve();
    });
    await flush();

    const err: XServerError = {
      kind: "dependencyMissing",
      message: "VcXsrv is not installed",
      dependency: "VcXsrv",
      installHint: "Download VcXsrv from SourceForge",
      installCommand: "choco install vcxsrv",
    };
    await act(async () => {
      ensure.reject(err);
      await Promise.resolve();
    });
    await flush();

    const errEl = document.querySelector('[data-testid="x-server-setup-error"]');
    expect(errEl?.textContent).toContain("VcXsrv is not installed");
    expect(document.querySelector('[data-testid="x-server-setup-install-dep"]')).not.toBeNull();
    // The install command is rendered for copy/paste.
    expect(document.body.textContent).toContain("choco install vcxsrv");

    await act(async () => {
      click("x-server-setup-install-dep");
      await Promise.resolve();
    });
    await flush();

    expect(xServerInstallDependency).toHaveBeenCalledTimes(1);
  });

  it("surfaces the message and a Retry action on a generic failure", async () => {
    const ensure = deferred<XServerStatusReport>();
    xServerEnsure.mockReturnValue(ensure.promise);

    renderDialog({});

    await act(async () => {
      click("x-server-setup-enable");
      await Promise.resolve();
    });
    await flush();

    const err: XServerError = {
      kind: "provisioningUnavailable",
      message: "Provisioning is not available on this platform",
    };
    await act(async () => {
      ensure.reject(err);
      await Promise.resolve();
    });
    await flush();

    const errEl = document.querySelector('[data-testid="x-server-setup-error"]');
    expect(errEl?.textContent).toContain("Provisioning is not available on this platform");
    // No install action for a non-dependency failure, but Retry is offered.
    expect(document.querySelector('[data-testid="x-server-setup-install-dep"]')).toBeNull();
    expect(document.querySelector('[data-testid="x-server-setup-retry"]')).not.toBeNull();
  });
});
