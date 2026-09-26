/**
 * Tests for the missing-plugin marker in the connection tree (#3344).
 *
 * A saved connection whose `plugin:<id>:<type>` type names a plugin that is not
 * installed, disabled or not loaded (trust gate) renders muted with a warning
 * badge naming the plugin, offers a shortcut to the plugin manager, and clears
 * live once the plugin becomes active. Built-in connections are never marked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { ConnectionList } from "./ConnectionList";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { TooltipProvider, toast } from "@/components/ui";
import { backendPlugin } from "@/test/pluginFixtures";
import type { SavedConnection } from "@/types/connection";
import { createTerminal } from "@/services/api";

vi.mock("@/services/api", () => ({
  listAvailableShells: vi.fn(() => Promise.resolve([])),
  createTerminal: vi.fn(() => Promise.resolve({ sessionId: "s1" })),
  removeCredential: vi.fn(),
  storeCredential: vi.fn(),
  isSshKeyEncrypted: vi.fn(() => Promise.resolve(false)),
  resolveCredential: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn(), frontendError: vi.fn() }));

const baseSettings = {
  version: "1",
  externalConnectionFiles: [] as [],
  powerMonitoringEnabled: false,
  fileBrowserEnabled: false,
  experimentalFeaturesEnabled: false,
};

function conn(id: string, type: string): SavedConnection {
  return { id, name: id, folderId: null, config: { type, config: {} } };
}

setupConnectionsRegion();
setupSettingsRegion();

describe("ConnectionList — missing-plugin marker", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    seedSettings({ ...baseSettings });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  function render(connections: SavedConnection[]) {
    seedConnectionsRegion({ connections });
    act(() =>
      root.render(
        React.createElement(TooltipProvider, {
          delayDuration: 0,
          children: React.createElement(ConnectionList),
        })
      )
    );
  }

  const badge = (id: string) =>
    container.querySelector(`[data-testid="connection-plugin-missing-${id}"]`);
  const row = (id: string) => container.querySelector(`[data-testid="connection-item-${id}"]`);

  it("marks a connection whose plugin is not installed, naming the plugin", () => {
    useAppStore.setState({ plugins: [], pluginsLoaded: true });
    render([conn("kube", "plugin:acme:k8s"), conn("shell", "local")]);

    expect(badge("kube")?.getAttribute("aria-label")).toBe("Plugin 'acme' is not installed");
    expect(badge("kube")?.getAttribute("data-reason")).toBe("not-installed");
    expect(row("kube")?.className).toContain("connection-tree__item--unavailable");
    expect(row("kube")?.getAttribute("title")).toBe("kube: Plugin 'acme' is not installed");
    // Built-in connections are never marked.
    expect(badge("shell")).toBeNull();
    expect(row("shell")?.className).not.toContain("--unavailable");
  });

  it("distinguishes a disabled plugin from a missing one", () => {
    useAppStore.setState({
      plugins: [backendPlugin("acme", "k8s", "disabled", "Acme K8s")],
      pluginsLoaded: true,
    });
    render([conn("kube", "plugin:acme:k8s")]);
    expect(badge("kube")?.getAttribute("aria-label")).toBe("Plugin 'Acme K8s' is disabled");
  });

  it("shows no marker before the plugin list has loaded", () => {
    useAppStore.setState({ plugins: [], pluginsLoaded: false });
    render([conn("kube", "plugin:acme:k8s")]);
    expect(badge("kube")).toBeNull();
  });

  it("clears the marker live when the plugin becomes active", () => {
    useAppStore.setState({
      plugins: [backendPlugin("acme", "k8s", "installed")],
      pluginsLoaded: true,
    });
    render([conn("kube", "plugin:acme:k8s")]);
    expect(badge("kube")?.getAttribute("data-reason")).toBe("not-loaded");

    act(() => useAppStore.setState({ plugins: [backendPlugin("acme", "k8s", "active")] }));
    expect(badge("kube")).toBeNull();
    expect(row("kube")?.className).not.toContain("--unavailable");
  });

  it("blocks connect with the marker's message instead of opening a tab", async () => {
    const errorSpy = vi.spyOn(toast, "error").mockReturnValue("err");
    const addTab = vi.fn();
    useAppStore.setState({
      plugins: [],
      pluginsLoaded: true,
      addTab: addTab as unknown as ReturnType<typeof useAppStore.getState>["addTab"],
    });
    render([conn("kube", "plugin:acme:k8s")]);

    const connectBtn = container.querySelector(
      '[data-testid="connection-connect-kube"]'
    ) as HTMLButtonElement;
    await act(async () => {
      connectBtn.click();
      await Promise.resolve();
    });
    expect(errorSpy).toHaveBeenCalledWith("Cannot connect to kube: Plugin 'acme' is not installed");
    expect(addTab).not.toHaveBeenCalled();
    expect(vi.mocked(createTerminal)).not.toHaveBeenCalled();
  });

  function openMenu(id: string) {
    act(() => {
      row(id)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });
    return document.querySelector(
      '[data-testid="context-connection-manage-plugin"]'
    ) as HTMLElement | null;
  }

  it("offers the Plugins sidebar to install a missing plugin", () => {
    const setSidebarView = vi.fn();
    useAppStore.setState({ plugins: [], pluginsLoaded: true, setSidebarView });
    render([conn("kube", "plugin:acme:k8s")]);
    const item = openMenu("kube");
    expect(item?.textContent).toContain("Install Plugin 'acme'");
    act(() => item!.click());
    expect(setSidebarView).toHaveBeenCalledWith("plugins");
  });

  it("opens an installed plugin's detail to enable or trust it", () => {
    const selectPlugin = vi.fn();
    useAppStore.setState({
      plugins: [backendPlugin("acme", "k8s", "disabled", "Acme K8s")],
      pluginsLoaded: true,
      selectPlugin,
    });
    render([conn("kube", "plugin:acme:k8s")]);
    const item = openMenu("kube");
    expect(item?.textContent).toContain("Manage Plugin 'Acme K8s'");
    act(() => item!.click());
    expect(selectPlugin).toHaveBeenCalledWith("acme");
  });

  it("offers no plugin shortcut for an available connection", () => {
    useAppStore.setState({ plugins: [backendPlugin("acme", "k8s")], pluginsLoaded: true });
    render([conn("kube", "plugin:acme:k8s")]);
    expect(openMenu("kube")).toBeNull();
  });
});
