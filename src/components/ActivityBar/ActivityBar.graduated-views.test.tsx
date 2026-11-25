/**
 * Services, network tools (#5858) and Automations (#5818) show in
 * the activity bar with experimental features off. One Automations item replaces
 * Macros and Workflows. A view the user hid stays hidden.
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
  services: "activity-bar-services",
  "network-tools": "activity-bar-network-tools",
  automations: "activity-bar-automations",
} as const;
const REPLACED = ["activity-bar-macros", "activity-bar-workflows", "activity-bar-ssh-tunnels"];

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

describe("ActivityBar — graduated views (#5858, #5818)", () => {
  it("shows every graduated view with experimental features off", async () => {
    seedSettings({ experimentalFeaturesEnabled: false });
    await render();
    for (const testId of Object.values(GRADUATED)) {
      expect(item(testId), testId).not.toBeNull();
    }
    for (const testId of REPLACED) expect(item(testId), testId).toBeNull();
  });

  it("shows the same views with experimental features on", async () => {
    seedSettings({ experimentalFeaturesEnabled: true });
    await render();
    for (const testId of Object.values(GRADUATED)) {
      expect(item(testId), testId).not.toBeNull();
    }
    for (const testId of REPLACED) expect(item(testId), testId).toBeNull();
  });

  it("opens a graduated view with experimental features off", async () => {
    seedSettings({ experimentalFeaturesEnabled: false });
    await render();
    act(() => (item(GRADUATED["network-tools"]) as HTMLElement).click());
    expect(useAppStore.getState().sidebarView).toBe("network-tools");
  });

  it("opens Automations", async () => {
    await render();
    act(() => (item(GRADUATED.automations) as HTMLElement).click());
    expect(useAppStore.getState().sidebarView).toBe("automations");
  });

  it("keeps a view the user hid hidden", async () => {
    seedSettings({ experimentalFeaturesEnabled: false });
    hideViews(["services", "automations"]);
    await render();
    expect(item(GRADUATED.automations)).toBeNull();
    expect(item(GRADUATED.services)).toBeNull();
    expect(item(GRADUATED["network-tools"])).not.toBeNull();
  });
});
