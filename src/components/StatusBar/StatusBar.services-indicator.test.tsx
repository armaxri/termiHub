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
    expect(item!.getAttribute("aria-label")).toBe(
      "1 file server running — click to open File servers"
    );
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
    expect(item!.getAttribute("aria-label")).toBe(
      "1 file server running — click to open File servers"
    );
    act(() => item!.click());
    expect(setSidebarView).toHaveBeenCalledWith("services");
  });

  it("counts tunnels, too, and opens them when no file server runs (#6063)", async () => {
    seedSettings({ experimentalFeaturesEnabled: false });
    const tunnelStates = {
      a: { status: "connected" },
      b: { status: "connected" },
      c: { status: "notReachable" },
    } as never;
    const tunnels = [{ id: "a" }, { id: "b" }, { id: "c" }] as never;
    useAppStore.setState({ tunnels, tunnelStates });
    act(() => renderStatusBar(root));
    await flushAsync();
    expect(indicator()!.textContent).toBe("3 running");
    expect(indicator()!.getAttribute("aria-label")).toBe(
      "2 tunnels and 1 file server running — click to open File servers"
    );

    act(() => useAppStore.setState({ embeddedServerStates: {} }));
    expect(indicator()!.textContent).toBe("2 running");
    act(() => indicator()!.click());
    expect(setSidebarView).toHaveBeenCalledWith("tunnels");

    act(() => useAppStore.setState({ tunnelStates: {} }));
    expect(indicator()).toBeNull();
  });
});
