/**
 * Experimental gating of the status-bar running-services indicator (#4498).
 *
 * The indicator links into the Services sidebar, an experimental view hidden
 * when experimental features are off. With the toggle off it must stay visible
 * (a running server is never invisible) but must not navigate into the hidden
 * view; with the toggle on it is a button that opens the Services sidebar.
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

describe("StatusBar — services indicator experimental gating (#4498)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let setSidebarView: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    setSidebarView = vi.fn();
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

  it("stays visible but does not open the hidden Services view when experimental is off", async () => {
    seedSettings({ experimentalFeaturesEnabled: false });
    act(() => renderStatusBar(root));
    await flushAsync();

    const item = indicator();
    expect(item).not.toBeNull();
    expect(item!.tagName).toBe("SPAN");
    expect(item!.getAttribute("aria-label")).toBe("1 service running");
    act(() => item!.click());
    expect(setSidebarView).not.toHaveBeenCalled();
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
