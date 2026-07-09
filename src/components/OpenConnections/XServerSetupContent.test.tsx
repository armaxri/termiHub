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
    onGuideHomebrewInstall?: (command: string) => void | Promise<void>;
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
          onGuideHomebrewInstall: o.onGuideHomebrewInstall ?? (() => Promise.resolve()),
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
      error: { kind: "provisioningUnavailable", message: "Not available here" },
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

  it("offers a guided terminal install for an installMode:guidedTerminal error", async () => {
    const onGuideHomebrewInstall = vi.fn(() => Promise.resolve());
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
      },
      onGuideHomebrewInstall,
      onInstallDependency,
    });
    // The generic "Install <dep>" action is replaced by a guided install action
    // (which opens a terminal) plus a manual xquartz.org fallback link.
    expect(query("x-server-setup-install-dep")).toBeNull();
    const brew = query("x-server-setup-install-homebrew");
    expect(brew).not.toBeNull();
    expect(brew?.textContent).toContain("Install Homebrew");
    expect(query("x-server-setup-open-xquartz")).not.toBeNull();
    await act(async () => {
      click("x-server-setup-install-homebrew");
      await Promise.resolve();
    });
    expect(onGuideHomebrewInstall).toHaveBeenCalledWith(cmd);
    expect(onInstallDependency).not.toHaveBeenCalled();
  });

  it("keys the guided path on installMode, not the dependency name", async () => {
    const onGuideHomebrewInstall = vi.fn(() => Promise.resolve());
    const onInstallDependency = vi.fn(() => Promise.resolve());
    const cmd = "curl -fsSL https://example.test/install.sh | sh";
    // A dependency named anything but "Homebrew": the retired magic-string branch
    // would miss it, but the typed installMode drives the guided terminal (#1309).
    renderContent({
      phase: "error",
      error: {
        kind: "dependencyMissing",
        message: "Toolchain is not installed",
        dependency: "Toolchain",
        installMode: "guidedTerminal",
        installCommand: cmd,
      },
      onGuideHomebrewInstall,
      onInstallDependency,
    });
    expect(query("x-server-setup-install-dep")).toBeNull();
    const guided = query("x-server-setup-install-homebrew");
    expect(guided?.textContent).toContain("Install Toolchain");
    await act(async () => {
      click("x-server-setup-install-homebrew");
      await Promise.resolve();
    });
    expect(onGuideHomebrewInstall).toHaveBeenCalledWith(cmd);
    expect(onInstallDependency).not.toHaveBeenCalled();
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
    expect(query("x-server-setup-install-homebrew")).toBeNull();
    expect(query("x-server-setup-open-xquartz")).toBeNull();
    expect(query("x-server-setup-install-dep")?.textContent).toContain("Install Homebrew");
  });

  it("falls back to the raw error message when no typed error is present", () => {
    renderContent({ phase: "error", error: null, rawError: "boom on connect" });
    expect(query("x-server-setup-error")?.textContent).toContain("boom on connect");
  });
});
