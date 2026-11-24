/**
 * SSH tunnels, services and network tools graduated from the experimental
 * switch (#5858): their activity-bar items show with experimental features off,
 * while the views still behind the switch (workflows) stay hidden. A view the
 * user hid from the activity bar stays hidden after the graduation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { withTooltip } from "@/test/tooltip";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { flushAsync } from "@/test/flushAsync";
import { ActivityBar } from "./ActivityBar";

vi.mock("@/components/OpenConnections/OpenConnectionsModal", () => ({
  OpenConnectionsModal: () => null,
}));

setupSettingsRegion();

const GRADUATED = {
  tunnels: "activity-bar-ssh-tunnels",
  services: "activity-bar-services",
  "network-tools": "activity-bar-network-tools",
} as const;
const WORKFLOWS = "activity-bar-workflows";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useAppStore.setState(useAppStore.getInitialState());
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useAppStore.setState(useAppStore.getInitialState());
});

async function render(): Promise<void> {
  act(() => root.render(withTooltip(<ActivityBar />)));
  await flushAsync();
}

const item = (testId: string) => container.querySelector(`[data-testid="${testId}"]`);

function hideViews(views: string[]): void {
  const layoutConfig = useAppStore.getState().layoutConfig;
  useAppStore.setState({ layoutConfig: { ...layoutConfig, hiddenActivityBarViews: views } });
}

describe("ActivityBar — graduated views (#5858)", () => {
  it("shows SSH tunnels, services and network tools with experimental features off", async () => {
    seedSettings({ experimentalFeaturesEnabled: false });
    await render();
    for (const testId of Object.values(GRADUATED)) {
      expect(item(testId), testId).not.toBeNull();
    }
    // Workflows are still behind the switch until #5818 graduates them.
    expect(item(WORKFLOWS)).toBeNull();
  });

  it("shows them with experimental features on, next to workflows", async () => {
    seedSettings({ experimentalFeaturesEnabled: true });
    await render();
    for (const testId of Object.values(GRADUATED)) {
      expect(item(testId), testId).not.toBeNull();
    }
    expect(item(WORKFLOWS)).not.toBeNull();
  });

  it("opens a graduated view with experimental features off", async () => {
    seedSettings({ experimentalFeaturesEnabled: false });
    await render();
    act(() => (item(GRADUATED["network-tools"]) as HTMLElement).click());
    expect(useAppStore.getState().sidebarView).toBe("network-tools");
  });

  it("keeps a view the user hid hidden", async () => {
    seedSettings({ experimentalFeaturesEnabled: false });
    hideViews(["tunnels", "services"]);
    await render();
    expect(item(GRADUATED.tunnels)).toBeNull();
    expect(item(GRADUATED.services)).toBeNull();
    expect(item(GRADUATED["network-tools"])).not.toBeNull();
  });
});
