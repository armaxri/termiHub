/**
 * Tests for the shared X server consent/progress/error body (#1296). The same
 * presentational component backs both the manual setup dialog and the
 * connect-triggered consent dialog, so it is exercised here with both testid
 * prefixes: it renders the consent slot, the progress bar, and a recoverable
 * error screen (Retry always; Install only for a dependencyMissing failure).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { XServerError, XServerProgress } from "@/types/xserver";
import { XServerSetupContent } from "./XServerSetupContent";

describe("XServerSetupContent", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  interface Overrides {
    prefix?: string;
    phase?: "consent" | "provisioning" | "error";
    progress?: XServerProgress | null;
    error?: XServerError | null;
    rawError?: unknown;
    onEnable?: () => void;
    onNotNow?: () => void;
    onRetry?: () => void;
    onInstallDependency?: () => Promise<void>;
    onGuideTerminalInstall?: (command: string, tabTitle: string) => void | Promise<void>;
    onClose?: () => void;
  }

  function renderContent(o: Overrides = {}) {
    const prefix = o.prefix ?? "x-server-setup";
    act(() => {
      root.render(
        React.createElement(XServerSetupContent, {
          open: true,
          onOpenChange: () => {},
          testIdPrefix: prefix,
          phase: o.phase ?? "consent",
          progress: o.progress ?? null,
          error: o.error ?? null,
          rawError: o.rawError,
          consent: React.createElement("div", { "data-testid": `${prefix}-body` }, "consent copy"),
          onEnable: o.onEnable ?? (() => {}),
          onNotNow: o.onNotNow ?? (() => {}),
          onRetry: o.onRetry ?? (() => {}),
          onInstallDependency: o.onInstallDependency ?? (() => Promise.resolve()),
          onGuideTerminalInstall: o.onGuideTerminalInstall ?? (() => Promise.resolve()),
          onClose: o.onClose ?? (() => {}),
        })
      );
    });
  }

  function query(testId: string): Element | null {
    return document.querySelector(`[data-testid="${testId}"]`);
  }

  function click(testId: string) {
    const el = query(testId) as HTMLButtonElement | null;
    if (!el) throw new Error(`missing element: ${testId}`);
    el.click();
  }

  it("renders the consent slot and footer actions for both prefixes", () => {
    for (const prefix of ["x-server-setup", "x-server-connect-consent"]) {
      renderContent({ prefix });
      expect(query(`${prefix}-dialog`)).not.toBeNull();
      expect(query(`${prefix}-body`)).not.toBeNull();
      expect(query(`${prefix}-enable`)).not.toBeNull();
      expect(query(`${prefix}-not-now`)).not.toBeNull();
    }
  });

  it("wires Enable and Not now to their handlers", () => {
    const onEnable = vi.fn();
    const onNotNow = vi.fn();
    renderContent({ onEnable, onNotNow });
    click("x-server-setup-enable");
    click("x-server-setup-not-now");
    expect(onEnable).toHaveBeenCalledTimes(1);
    expect(onNotNow).toHaveBeenCalledTimes(1);
  });

  it("renders a determinate progress bar in the provisioning phase", () => {
    renderContent({
      phase: "provisioning",
      progress: { step: "download", message: "Downloading…", progress: 0.5 },
    });
    const bar = query("x-server-setup-progress");
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute("aria-valuenow")).toBe("50");
    // No footer actions while work is in flight.
    expect(query("x-server-setup-enable")).toBeNull();
    expect(query("x-server-setup-not-now")).toBeNull();
  });

  it("shows Retry (no Install) on a generic error", () => {
    const onRetry = vi.fn();
    renderContent({
      phase: "error",
      error: { kind: "launchFailed", message: "Not available here" },
      onRetry,
    });
    expect(query("x-server-setup-error")?.textContent).toContain("Not available here");
    expect(query("x-server-setup-retry")).not.toBeNull();
    expect(query("x-server-setup-install-dep")).toBeNull();
    click("x-server-setup-retry");
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows an Install action for a dependencyMissing error", async () => {
    const onInstallDependency = vi.fn(() => Promise.resolve());
    renderContent({
      phase: "error",
      error: {
        kind: "dependencyMissing",
        message: "XQuartz is not installed",
        dependency: "XQuartz",
        installHint: "Install XQuartz from xquartz.org",
        installCommand: "brew install --cask xquartz",
      },
      onInstallDependency,
    });
    expect(query("x-server-setup-error")?.textContent).toContain("XQuartz is not installed");
    expect(document.body.textContent).toContain("brew install --cask xquartz");
    const install = query("x-server-setup-install-dep");
    expect(install).not.toBeNull();
    expect(install?.textContent).toContain("Install XQuartz");
    await act(async () => {
      click("x-server-setup-install-dep");
      await Promise.resolve();
    });
    expect(onInstallDependency).toHaveBeenCalledTimes(1);
  });

  it("offers a guided terminal install with a payload-driven fallback link", async () => {
    const onGuideTerminalInstall = vi.fn(() => Promise.resolve());
    const onInstallDependency = vi.fn(() => Promise.resolve());
    const cmd = '/bin/bash -c "$(curl -fsSL https://example.test/install.sh)"';
    renderContent({
      phase: "error",
      error: {
        kind: "dependencyMissing",
        message: "Homebrew is not installed",
        dependency: "Homebrew",
        installMode: "guidedTerminal",
        installHint: "Install Homebrew, or install XQuartz manually from xquartz.org",
        installCommand: cmd,
        installFallbackUrl: "https://www.xquartz.org",
      },
      onGuideTerminalInstall,
      onInstallDependency,
    });
    // The generic "Install <dep>" action is replaced by a guided install action
    // (which opens a terminal) plus a manual fallback link derived from the URL.
    expect(query("x-server-setup-install-dep")).toBeNull();
    const guided = query("x-server-setup-guided-install");
    expect(guided?.textContent).toContain("Install Homebrew");
    expect(query("x-server-setup-open-fallback")?.textContent).toContain("Open xquartz.org");
    await act(async () => {
      click("x-server-setup-guided-install");
      await Promise.resolve();
    });
    // The tab title is derived from the (presentational) dependency name.
    expect(onGuideTerminalInstall).toHaveBeenCalledWith(cmd, "Install Homebrew");
    expect(onInstallDependency).not.toHaveBeenCalled();
  });

  it("keys the guided path on installMode and omits the fallback when none is provided", async () => {
    const onGuideTerminalInstall = vi.fn(() => Promise.resolve());
    const onInstallDependency = vi.fn(() => Promise.resolve());
    const cmd = "curl -fsSL https://example.test/install.sh | sh";
    // A dependency named anything but "Homebrew" and with no fallback URL: the
    // typed installMode still drives the guided terminal (#1309) and the fallback
    // button stays absent because the payload provides none (#1312).
    renderContent({
      phase: "error",
      error: {
        kind: "dependencyMissing",
        message: "Toolchain is not installed",
        dependency: "Toolchain",
        installMode: "guidedTerminal",
        installCommand: cmd,
      },
      onGuideTerminalInstall,
      onInstallDependency,
    });
    expect(query("x-server-setup-install-dep")).toBeNull();
    expect(query("x-server-setup-open-fallback")).toBeNull();
    const guided = query("x-server-setup-guided-install");
    expect(guided?.textContent).toContain("Install Toolchain");
    await act(async () => {
      click("x-server-setup-guided-install");
      await Promise.resolve();
    });
    expect(onGuideTerminalInstall).toHaveBeenCalledWith(cmd, "Install Toolchain");
    expect(onInstallDependency).not.toHaveBeenCalled();
  });

  it("derives the fallback button label from a non-xquartz payload URL", () => {
    // Proves the fallback link points correctly for a second guided dependency —
    // no hardcoded xquartz.org (#1312).
    renderContent({
      phase: "error",
      error: {
        kind: "dependencyMissing",
        message: "Toolchain is not installed",
        dependency: "Toolchain",
        installMode: "guidedTerminal",
        installCommand: "install-toolchain",
        installFallbackUrl: "https://downloads.toolchain.example/get",
      },
    });
    expect(query("x-server-setup-open-fallback")?.textContent).toContain(
      "Open downloads.toolchain.example"
    );
  });

  it("uses the backend install action when dependency is Homebrew but installMode is backend", () => {
    // The name alone no longer forces the guided terminal: a `backend` install
    // mode gets the plain install-and-retry, even for a "Homebrew" dependency.
    renderContent({
      phase: "error",
      error: {
        kind: "dependencyMissing",
        message: "Homebrew is not installed",
        dependency: "Homebrew",
        installMode: "backend",
        installCommand: "brew install --cask xquartz",
      },
    });
    expect(query("x-server-setup-guided-install")).toBeNull();
    expect(query("x-server-setup-open-fallback")).toBeNull();
    expect(query("x-server-setup-install-dep")?.textContent).toContain("Install Homebrew");
  });

  it("offers App Installer + a payload-driven fallback for an installMode:guidedExternal error", () => {
    // No terminal command and no backend install: the winget-absent case opens
    // the Store for App Installer plus the payload-driven manual VcXsrv download
    // (#1312/#1318). The generic "Install <dep>" backend action must NOT be shown
    // (it would loop back to winget_required).
    const onInstallDependency = vi.fn(() => Promise.resolve());
    renderContent({
      phase: "error",
      error: {
        kind: "dependencyMissing",
        message: "VcXsrv can't be installed because winget is missing",
        dependency: "winget",
        installMode: "guidedExternal",
        installHint: "Install App Installer, or download VcXsrv manually",
        installFallbackUrl: "https://sourceforge.net/projects/vcxsrv/",
      },
      onInstallDependency,
    });
    expect(query("x-server-setup-install-dep")).toBeNull();
    const appInstaller = query("x-server-setup-install-app-installer");
    expect(appInstaller).not.toBeNull();
    expect(appInstaller?.textContent).toContain("Install App Installer");
    // Manual fallback is payload-driven: label derived from the URL host.
    expect(query("x-server-setup-open-fallback")?.textContent).toContain("Open sourceforge.net");
    // Retry (re-detect winget) is always present on the error screen.
    expect(query("x-server-setup-retry")).not.toBeNull();
    expect(onInstallDependency).not.toHaveBeenCalled();
  });

  it("falls back to the raw error message when no typed error is present", () => {
    renderContent({ phase: "error", error: null, rawError: "boom on connect" });
    expect(query("x-server-setup-error")?.textContent).toContain("boom on connect");
  });
});
