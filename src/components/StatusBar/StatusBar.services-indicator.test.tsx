/**
 * The status-bar running-services indicator (#4498, #5858).
 *
 * Services graduated from the experimental switch (#5858), so the indicator is
 * a button that opens the Services sidebar whether experimental features are
 * on or off.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { flushAsync } from "@/test/flushAsync";
import { StatusBar } from "./StatusBar";

setupSettingsRegion();

function renderStatusBar(root: Root) {
  root.render(React.createElement(TooltipProvider, null, React.createElement(StatusBar)));
}

describe("StatusBar — services indicator (#4498, #5858)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let setSidebarView: ReturnType<typeof vi.fn<(view: string) => void>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    setSidebarView = vi.fn<(view: string) => void>();
    useAppStore.setState({
      embeddedServerStates: { s1: { status: "running" } as never },
      setSidebarView,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useAppStore.setState(useAppStore.getInitialState());
  });

  const indicator = () =>
    container.querySelector<HTMLElement>('[data-testid="services-indicator"]');

  it("opens the Services sidebar on click with experimental features off (#5858)", async () => {
    seedSettings({ experimentalFeaturesEnabled: false });
    act(() => renderStatusBar(root));
    await flushAsync();

    const item = indicator();
    expect(item).not.toBeNull();
    expect(item!.tagName).toBe("BUTTON");
    expect(item!.getAttribute("aria-label")).toContain("click to open Services");
    act(() => item!.click());
    expect(setSidebarView).toHaveBeenCalledWith("services");
  });

  it("opens the Services sidebar on click when experimental is on", async () => {
    seedSettings({ experimentalFeaturesEnabled: true });
    act(() => renderStatusBar(root));
    await flushAsync();

    const item = indicator();
    expect(item).not.toBeNull();
    expect(item!.tagName).toBe("BUTTON");
    expect(item!.getAttribute("aria-label")).toContain("click to open Services");
    act(() => item!.click());
    expect(setSidebarView).toHaveBeenCalledWith("services");
  });
});
