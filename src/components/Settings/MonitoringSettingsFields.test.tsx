import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import type { AppSettings } from "@/types/connection";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { MonitoringSettingsFields } from "./MonitoringSettingsFields";

setupSettingsRegion();

let container: HTMLDivElement;
let root: Root;
let updateSettings: ReturnType<typeof vi.fn<(s: AppSettings) => Promise<void>>>;

function render(settings: Partial<AppSettings> = {}) {
  seedSettings({ powerMonitoringEnabled: true, fileBrowserEnabled: true, ...settings });
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <MonitoringSettingsFields />
      </TooltipProvider>
    );
  });
}

const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const checked = (id: string) => q(id)!.getAttribute("aria-checked") === "true";

describe("MonitoringSettingsFields (#5754)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    updateSettings = vi.fn((_s: AppSettings) => Promise.resolve());
    useAppStore.setState({ updateSettings });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("defaults to local shells off and every chip but swap", () => {
    render();
    expect(checked("toggle-monitor-local-shells")).toBe(false);
    for (const m of ["cpu", "memory", "disk", "network"]) {
      expect(checked(`status-bar-metric-${m}`), m).toBe(true);
    }
    expect(checked("status-bar-metric-swap")).toBe(false);
  });

  it("saves selecting swap as an explicit, ordered chip list", () => {
    render();
    act(() => q("status-bar-metric-swap")!.click());
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ statusBarMetrics: ["cpu", "memory", "disk", "swap", "network"] })
    );
  });

  it("keeps an explicit chip choice", () => {
    render({ statusBarMetrics: ["swap"] });
    expect(checked("status-bar-metric-swap")).toBe(true);
    expect(checked("status-bar-metric-cpu")).toBe(false);
  });

  it("turns on local shell monitoring", () => {
    render();
    act(() => q("toggle-monitor-local-shells")!.click());
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ monitorLocalShells: true })
    );
  });
});
