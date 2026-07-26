/**
 * Tests for the plugin detail panel (#1997): identity/extension-points/permissions
 * rendering, state-appropriate actions (Enable/Disable/Retry, Settings…), the
 * error callout, and action dispatch to the store. Uninstall opens a confirm
 * dialog that warns about active sessions before dispatching.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import React from "react";
import { useAppStore } from "@/store/appStore";
import type { InstalledPlugin, PluginManifest, PluginState } from "@/types/plugin";
import { withTooltip } from "@/test/tooltip";
import { PluginDetailPanel } from "./PluginDetailPanel";

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "k8s",
    name: "Kubernetes Exec",
    version: "1.2.0",
    author: "k8s-contrib",
    description: "Terminal backend for Kubernetes pod exec sessions.",
    license: "MIT",
    apiVersion: "1.0",
    platforms: ["macos"],
    permissions: ["terminal", "network"],
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

function plugin(state: PluginState, m: Partial<PluginManifest> = {}): InstalledPlugin {
  return {
    manifest: manifest(m),
    state,
    errorMessage: state === "error" ? "dependency aws CLI not found in PATH" : undefined,
    installedAt: "2026-01-01T00:00:00Z",
  };
}

let container: HTMLDivElement;
let root: Root;

function render(pluginId = "k8s") {
  act(() =>
    root.render(
      withTooltip(React.createElement(PluginDetailPanel, { meta: { pluginId }, isVisible: true }))
    )
  );
}

describe("PluginDetailPanel (#1997)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders identity, extension points, and permissions", () => {
    useAppStore.setState({ plugins: [plugin("active")] });
    render();

    expect(container.querySelector('[data-testid="plugin-detail"]')?.textContent).toContain(
      "Kubernetes Exec"
    );
    expect(container.querySelector('[data-testid="plugin-detail-status"]')?.textContent).toContain(
      "Enabled"
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Terminal Backend");
    expect(text).toContain("k8s-exec");
    expect(text).toContain("Terminal");
    expect(text).toContain("create and manage terminal sessions");
  });

  it("shows Disable for an enabled plugin and dispatches it", () => {
    const disablePlugin = vi.fn(() => Promise.resolve());
    useAppStore.setState({ plugins: [plugin("active")], disablePlugin });
    render();

    const btn = container.querySelector('[data-testid="plugin-action-disable"]');
    expect(btn).not.toBeNull();
    expect(container.querySelector('[data-testid="plugin-action-enable"]')).toBeNull();
    act(() => btn!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(disablePlugin).toHaveBeenCalledWith("k8s");
  });

  it("shows Enable for a disabled plugin and dispatches it", () => {
    const enablePlugin = vi.fn(() => Promise.resolve());
    useAppStore.setState({ plugins: [plugin("disabled")], enablePlugin });
    render();

    const btn = container.querySelector('[data-testid="plugin-action-enable"]');
    expect(btn).not.toBeNull();
    act(() => btn!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(enablePlugin).toHaveBeenCalledWith("k8s");
  });

  it("shows Retry and the error callout for a failed plugin", () => {
    const enablePlugin = vi.fn(() => Promise.resolve());
    useAppStore.setState({ plugins: [plugin("error")], enablePlugin });
    render();

    expect(container.querySelector('[data-testid="plugin-detail-error"]')?.textContent).toContain(
      "dependency aws CLI not found"
    );
    const btn = container.querySelector('[data-testid="plugin-action-retry"]');
    expect(btn).not.toBeNull();
    act(() => btn!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(enablePlugin).toHaveBeenCalledWith("k8s");
  });

  it("shows the Settings… action only when settings are declared", () => {
    useAppStore.setState({ plugins: [plugin("active")] });
    render();
    expect(container.querySelector('[data-testid="plugin-action-settings"]')).toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    useAppStore.setState({
      plugins: [
        plugin("active", { settings: { ns: { type: "string", default: "", description: "" } } }),
      ],
    });
    render();
    expect(container.querySelector('[data-testid="plugin-action-settings"]')).not.toBeNull();
  });

  it("deep-links the Settings… action into the Plugins settings category for this plugin", () => {
    const openSettingsTab = vi.fn();
    useAppStore.setState({
      plugins: [
        plugin("active", { settings: { ns: { type: "string", default: "", description: "" } } }),
      ],
      openSettingsTab,
    });
    render();

    const btn = container.querySelector('[data-testid="plugin-action-settings"]');
    act(() => btn!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(openSettingsTab).toHaveBeenCalledWith({ category: "plugins", pluginId: "k8s" });
  });

  it("renders a placeholder when the plugin is no longer installed", () => {
    useAppStore.setState({ plugins: [] });
    render("gone");
    expect(container.querySelector('[data-testid="plugin-detail-missing"]')).not.toBeNull();
  });

  it("confirms before uninstalling and dispatches on confirm", async () => {
    const uninstallPlugin = vi.fn(() => Promise.resolve());
    useAppStore.setState({ plugins: [plugin("active")], uninstallPlugin });
    render();

    act(() =>
      container
        .querySelector('[data-testid="plugin-action-uninstall"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    const confirm = document.querySelector('[data-testid="plugin-uninstall-confirm"]');
    expect(confirm).not.toBeNull();
    expect(uninstallPlugin).not.toHaveBeenCalled();

    await act(async () => {
      confirm!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(uninstallPlugin).toHaveBeenCalledWith("k8s");
  });
});
