/**
 * Tests for the Plugins settings section (#2000): one group per plugin that
 * declares settings, rendered from its manifest schema; values load via
 * get_plugin_settings and a save round-trips through update_plugin_settings;
 * plugins with no declared settings are omitted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import React from "react";
import { useAppStore } from "@/store/appStore";
import type { InstalledPlugin, PluginManifest, PluginSettingSchema } from "@/types/plugin";
import { PluginSettingsSection } from "./PluginSettingsSection";

function manifest(
  id: string,
  settings: Record<string, PluginSettingSchema> | undefined,
  overrides: Partial<PluginManifest> = {}
): PluginManifest {
  return {
    id,
    name: `Plugin ${id}`,
    version: "1.0.0",
    author: "acme",
    description: `The ${id} plugin.`,
    license: "MIT",
    apiVersion: "1.0",
    platforms: ["macos"],
    permissions: ["settings"],
    extensions: { protocolParser: { name: id, description: "", entryPoint: "index.js" } },
    settings,
    ...overrides,
  };
}

function plugin(
  id: string,
  settings: Record<string, PluginSettingSchema> | undefined
): InstalledPlugin {
  return { manifest: manifest(id, settings), state: "active", installedAt: "2026-01-01T00:00:00Z" };
}

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

async function render(focusPluginId?: string | null) {
  await act(async () => {
    root.render(React.createElement(PluginSettingsSection, { focusPluginId }));
  });
  // Flush the async get_plugin_settings load chain (catch → then → setState).
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const setNativeValue = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

describe("PluginSettingsSection (#2000)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    vi.useRealTimers();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("renders one group per plugin that declares settings, with a badge", async () => {
    const getPluginSettings = vi.fn(() => Promise.resolve({}));
    useAppStore.setState({
      plugins: [
        plugin("log-colorizer", {
          namespace: { type: "string", default: "default", description: "Target namespace" },
        }),
      ],
      getPluginSettings,
    });
    await render();

    const group = query("plugin-settings-log-colorizer");
    expect(group).not.toBeNull();
    expect(group?.textContent).toContain("Plugin log-colorizer");
    expect(group?.textContent).toContain("plugin");
    // The declared field renders through DynamicForm.
    expect(query("field-namespace")).not.toBeNull();
    expect(getPluginSettings).toHaveBeenCalledWith("log-colorizer");
  });

  it("seeds the form with stored values layered over defaults", async () => {
    useAppStore.setState({
      plugins: [
        plugin("k8s", {
          namespace: { type: "string", default: "default", description: "" },
        }),
      ],
      getPluginSettings: vi.fn(() => Promise.resolve({ namespace: "kube-system" })),
    });
    await render();

    const input = query("field-namespace") as HTMLInputElement;
    expect(input.value).toBe("kube-system");
  });

  it("persists an edit through update_plugin_settings (save round-trip)", async () => {
    const updatePluginSettings = vi.fn(() => Promise.resolve());
    useAppStore.setState({
      plugins: [
        plugin("k8s", {
          namespace: { type: "string", default: "default", description: "" },
        }),
      ],
      getPluginSettings: vi.fn(() => Promise.resolve({ namespace: "default" })),
      updatePluginSettings,
    });
    await render();

    const input = query("field-namespace") as HTMLInputElement;
    act(() => setNativeValue(input, "prod"));

    // Wait out the 300ms save debounce, then flush the update promise.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });

    expect(updatePluginSettings).toHaveBeenCalledWith(
      "k8s",
      expect.objectContaining({ namespace: "prod" })
    );
    // Inline saved acknowledgment surfaces.
    expect(query("plugin-settings-saved-k8s")?.textContent).toContain("Saved");
  });

  it("omits plugins that declare no settings", async () => {
    useAppStore.setState({
      plugins: [
        plugin("has-none", undefined),
        plugin("has-empty", {}),
        plugin("has-one", { flag: { type: "boolean", default: false, description: "" } }),
      ],
      getPluginSettings: vi.fn(() => Promise.resolve({})),
    });
    await render();

    expect(query("plugin-settings-has-none")).toBeNull();
    expect(query("plugin-settings-has-empty")).toBeNull();
    expect(query("plugin-settings-has-one")).not.toBeNull();
  });

  it("shows an empty state when no plugin has configurable settings", async () => {
    useAppStore.setState({ plugins: [plugin("plain", undefined)] });
    await render();
    expect(query("plugin-settings-empty")).not.toBeNull();
  });
});
