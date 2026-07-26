/**
 * Tests for the install-from-file dialog (#1997, code-signing #2036): rendering
 * the parsed manifest and requested-permissions list, the four-state provenance
 * banner, and the install/cancel actions dispatching to the store with the right
 * trust flags.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import React from "react";
import { useAppStore } from "@/store/appStore";
import type { PluginManifest, PluginTrustInfo } from "@/types/plugin";
import { withTooltip } from "@/test/tooltip";
import { PluginInstallDialog } from "./PluginInstallDialog";

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "k8s",
    name: "Kubernetes Exec",
    version: "1.2.0",
    author: "k8s-contrib",
    description: "desc",
    license: "MIT",
    apiVersion: "1.0",
    platforms: ["macos"],
    permissions: ["terminal", "network", "filesystem"],
    extensions: {
      terminalBackend: {
        connectionType: "k8s-exec",
        displayName: "Kubernetes Exec",
        configSchema: {},
      },
    },
    ...overrides,
  };
}

function trust(overrides: Partial<PluginTrustInfo> = {}): PluginTrustInfo {
  return {
    level: "untrusted",
    warning: "This plugin comes from an unverified source. Only install plugins you trust.",
    keyId: null,
    publisher: null,
    publicKey: null,
    requiresAcceptance: true,
    isBlocked: false,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();

function render(
  m: PluginManifest,
  t: PluginTrustInfo = trust(),
  filePath = "/tmp/k8s-exec-1.2.0.termihub-plugin"
) {
  act(() =>
    root.render(
      withTooltip(
        React.createElement(PluginInstallDialog, { filePath, manifest: m, trust: t, onClose })
      )
    )
  );
}

function clickConfirm() {
  return act(async () => {
    document
      .querySelector('[data-testid="plugin-install-confirm"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("PluginInstallDialog (#1997/#2036)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    onClose.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the parsed manifest and requested permissions", () => {
    render(manifest());
    const dialog = document.querySelector('[data-testid="plugin-install-dialog"]')!;
    const text = dialog.textContent ?? "";
    expect(text).toContain("k8s-exec-1.2.0.termihub-plugin");
    expect(text).toContain("Kubernetes Exec");
    expect(text).toContain("1.2.0");
    expect(text).toContain("k8s-contrib");
    expect(text).toContain("Terminal Backend");
    expect(document.querySelector('[data-testid="plugin-install-perm-terminal"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="plugin-install-perm-filesystem"]')).not.toBeNull();
    expect(text).toContain("read and write files");
  });

  it("shows a no-permissions note when none are requested", () => {
    render(manifest({ permissions: [] }));
    expect(document.querySelector('[data-testid="plugin-install-no-perms"]')).not.toBeNull();
  });

  it("shows the untrusted-source banner for an unsigned package", () => {
    render(manifest());
    const banner = document.querySelector('[data-testid="plugin-install-trust-untrusted"]');
    expect(banner).not.toBeNull();
    expect(banner!.textContent ?? "").toContain("Untrusted source");
  });

  it("installs (accepting risk) then enables on confirm, selects the plugin, and closes", async () => {
    const installPlugin = vi.fn(() => Promise.resolve());
    const enablePlugin = vi.fn(() => Promise.resolve());
    const selectPlugin = vi.fn();
    useAppStore.setState({ installPlugin, enablePlugin, selectPlugin });
    render(manifest());

    await clickConfirm();

    // Unsigned → acceptUntrusted true, trustPublisher false.
    expect(installPlugin).toHaveBeenCalledWith("/tmp/k8s-exec-1.2.0.termihub-plugin", true, false);
    expect(enablePlugin).toHaveBeenCalledWith("k8s");
    expect(selectPlugin).toHaveBeenCalledWith("k8s");
    expect(onClose).toHaveBeenCalled();
  });

  it("verified publisher installs with no risk gate", async () => {
    const installPlugin = vi.fn(() => Promise.resolve());
    useAppStore.setState({ installPlugin, enablePlugin: vi.fn(() => Promise.resolve()) });
    render(
      manifest(),
      trust({
        level: "verified",
        warning: "",
        keyId: "sha256:ab12cd34ef56ab12cd34ef569f0e9f0e",
        publisher: "ACME Terminals",
        requiresAcceptance: false,
      })
    );

    const banner = document.querySelector('[data-testid="plugin-install-trust-verified"]');
    expect(banner!.textContent ?? "").toContain("Verified publisher");
    expect(banner!.textContent ?? "").toContain("ACME Terminals");

    await clickConfirm();
    // Verified → neither accept nor trust flag.
    expect(installPlugin).toHaveBeenCalledWith("/tmp/k8s-exec-1.2.0.termihub-plugin", false, false);
  });

  it("signed-unknown key pins the publisher when the box is ticked", async () => {
    const installPlugin = vi.fn(() => Promise.resolve());
    useAppStore.setState({ installPlugin, enablePlugin: vi.fn(() => Promise.resolve()) });
    render(
      manifest(),
      trust({
        level: "signed",
        warning: "",
        keyId: "sha256:77de11aa22bb33cc44dd55ee66ff1a3c",
        publicKey: "cHVia2V5",
        requiresAcceptance: true,
      })
    );

    expect(document.querySelector('[data-testid="plugin-install-trust-signed"]')).not.toBeNull();

    // Tick "Trust this publisher".
    act(() =>
      document
        .querySelector('[data-testid="plugin-install-trust-publisher"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    await clickConfirm();

    // Signed + ticked → acceptUntrusted false, trustPublisher true.
    expect(installPlugin).toHaveBeenCalledWith("/tmp/k8s-exec-1.2.0.termihub-plugin", false, true);
  });

  it("tampered package is blocked with no install action", () => {
    const installPlugin = vi.fn(() => Promise.resolve());
    useAppStore.setState({ installPlugin });
    render(
      manifest(),
      trust({ level: "tampered", warning: "Installation is blocked.", isBlocked: true })
    );

    expect(document.querySelector('[data-testid="plugin-install-trust-tampered"]')).not.toBeNull();
    // No install/confirm button, only Close.
    expect(document.querySelector('[data-testid="plugin-install-confirm"]')).toBeNull();
    expect(document.querySelector('[data-testid="plugin-install-close"]')).not.toBeNull();

    act(() =>
      document
        .querySelector('[data-testid="plugin-install-close"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    expect(installPlugin).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("closes without installing on Cancel", () => {
    const installPlugin = vi.fn(() => Promise.resolve());
    useAppStore.setState({ installPlugin });
    render(manifest());

    act(() =>
      document
        .querySelector('[data-testid="plugin-install-cancel"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    expect(installPlugin).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
