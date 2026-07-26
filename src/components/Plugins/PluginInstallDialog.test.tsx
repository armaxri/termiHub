/**
 * Tests for the install-from-file dialog (#1997): rendering the parsed manifest
 * and the requested-permissions list, and the Install & Enable / Cancel actions
 * dispatching to the store.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import React from "react";
import { useAppStore } from "@/store/appStore";
import type { PluginManifest } from "@/types/plugin";
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

let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();

function render(m: PluginManifest, filePath = "/tmp/k8s-exec-1.2.0.termihub-plugin") {
  act(() =>
    root.render(
      withTooltip(React.createElement(PluginInstallDialog, { filePath, manifest: m, onClose }))
    )
  );
}

describe("PluginInstallDialog (#1997)", () => {
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

  it("always warns that the source is untrusted", () => {
    render(manifest());
    const warning = document.querySelector('[data-testid="plugin-install-untrusted-warning"]');
    expect(warning).not.toBeNull();
    expect(warning!.textContent ?? "").toContain("Untrusted source");
  });

  it("installs then enables on confirm, selects the plugin, and closes", async () => {
    const installPlugin = vi.fn(() => Promise.resolve());
    const enablePlugin = vi.fn(() => Promise.resolve());
    const selectPlugin = vi.fn();
    useAppStore.setState({ installPlugin, enablePlugin, selectPlugin });
    render(manifest());

    await act(async () => {
      document
        .querySelector('[data-testid="plugin-install-confirm"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Confirming implies accepting the untrusted-source risk shown in the dialog.
    expect(installPlugin).toHaveBeenCalledWith("/tmp/k8s-exec-1.2.0.termihub-plugin", true);
    expect(enablePlugin).toHaveBeenCalledWith("k8s");
    expect(selectPlugin).toHaveBeenCalledWith("k8s");
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
