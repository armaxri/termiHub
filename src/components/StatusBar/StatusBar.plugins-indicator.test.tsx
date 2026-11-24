/**
 * The status-bar plugin item (#1997, #5931): it reads "1 plugin" / "3 plugins"
 * in words, not the cryptic "N · M"; the tooltip and accessible name add the
 * enabled count and say a click opens the Plugins sidebar.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import type { InstalledPlugin, PluginState } from "@/types/plugin";
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { flushAsync } from "@/test/flushAsync";
import { StatusBar } from "./StatusBar";

setupSettingsRegion();

function plugin(id: string, state: PluginState): InstalledPlugin {
  return {
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      author: "",
      description: "",
      license: "MIT",
      apiVersion: "1.0",
      platforms: ["macos"],
      permissions: [],
      extensions: {},
    },
    state,
    installedAt: 0,
  };
}

describe("StatusBar — plugins indicator (#5931)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let setSidebarView: ReturnType<typeof vi.fn<(view: string) => void>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    setSidebarView = vi.fn<(view: string) => void>();
    useAppStore.setState({ setSidebarView });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useAppStore.setState(useAppStore.getInitialState());
  });

  const indicator = () => container.querySelector<HTMLElement>('[data-testid="plugins-indicator"]');

  async function renderWith(plugins: InstalledPlugin[]) {
    useAppStore.setState({ plugins });
    act(() =>
      root.render(React.createElement(TooltipProvider, null, React.createElement(StatusBar)))
    );
    await flushAsync();
  }

  it("renders nothing with no plugins installed", async () => {
    await renderWith([]);
    expect(indicator()).toBeNull();
  });

  it("reads '1 plugin' for one installed plugin", async () => {
    await renderWith([plugin("a", "active")]);
    expect(indicator()!.textContent).toBe("1 plugin");
    expect(indicator()!.getAttribute("aria-label")).toBe(
      "1 plugin installed, 1 enabled — click to open the plugin list"
    );
  });

  it("reads '3 plugins' with the enabled count in the label, and opens Plugins", async () => {
    await renderWith([plugin("a", "active"), plugin("b", "disabled"), plugin("c", "error")]);
    const item = indicator()!;
    expect(item.textContent).toBe("3 plugins");
    expect(item.textContent).not.toContain("·");
    expect(item.getAttribute("aria-label")).toBe(
      "3 plugins installed, 1 enabled — click to open the plugin list"
    );
    act(() => item.click());
    expect(setSidebarView).toHaveBeenCalledWith("plugins");
  });
});
