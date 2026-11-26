import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import type { AppSettings } from "@/types/connection";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { MonitoringSettings, POWER_MONITORING_HELP } from "./MonitoringSettings";

setupSettingsRegion();

let container: HTMLDivElement;
let root: Root;

const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe("MonitoringSettings copy (#5930)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    useAppStore.setState({ updateSettings: vi.fn((_s: AppSettings) => Promise.resolve()) });
    seedSettings({ powerMonitoringEnabled: true });
    act(() => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <MonitoringSettings />
        </TooltipProvider>
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("no longer claims that turning it off disconnects sessions", () => {
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/disconnects active sessions/i);
    expect(text).not.toMatch(/SSH agent connections/);
  });

  it("names SSH connections in the one-line hint", () => {
    expect(q("settings-power-monitoring-hint")!.textContent).toBe(
      "Monitor CPU, memory and power events for SSH connections."
    );
    expect(q("settings-monitoring-remote-description")!.textContent).toBe(
      "Default for new SSH connections. Each connection can override it in its SSH settings."
    );
  });

  it("says behind the '?' that only the monitor stops and sessions stay connected", () => {
    const help = q("settings-power-monitoring-help");
    expect(help).not.toBeNull();
    expect(help!.getAttribute("aria-label")).toBe("More about host monitoring");
    expect(POWER_MONITORING_HELP).toMatch(/stops the CPU and memory monitor/);
    expect(POWER_MONITORING_HELP).toMatch(/stay connected/);
  });
});
