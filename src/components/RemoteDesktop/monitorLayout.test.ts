import { describe, it, expect, vi, beforeEach } from "vitest";
import { availableMonitors, primaryMonitor, type Monitor } from "@tauri-apps/api/window";
import {
  connectMonitorLayout,
  customLayout,
  customMonitorCount,
  isMultiMonitor,
  layoutFromLocalDisplays,
  monitorLabel,
  monitorModeOf,
  sameLayout,
  viewportsFor,
  type LocalDisplay,
} from "./monitorLayout";
import type { MonitorRect } from "@/types/remoteDesktop";

const mockedAvailable = vi.mocked(availableMonitors);
const mockedPrimary = vi.mocked(primaryMonitor);

function tauriMonitor(x: number, y: number, width: number, height: number, scaleFactor = 1) {
  return {
    name: null,
    position: { x, y },
    size: { width, height },
    workArea: { position: { x, y }, size: { width, height } },
    scaleFactor,
  } as unknown as Monitor;
}

const mon = (x: number, width: number, primary = false): MonitorRect => ({
  x,
  y: 0,
  width,
  height: 768,
  primary,
  scale: 100,
});

describe("monitor settings", () => {
  it("defaults to a single monitor", () => {
    expect(monitorModeOf({})).toBe("single");
    expect(monitorModeOf({ monitors: "bogus" })).toBe("single");
    expect(monitorModeOf({ monitors: " All " })).toBe("all");
    expect(isMultiMonitor({ monitors: "custom" })).toBe(true);
    expect(isMultiMonitor({ monitors: "single" })).toBe(false);
  });

  it("clamps the custom count to 2..16", () => {
    expect(customMonitorCount({})).toBe(2);
    expect(customMonitorCount({ monitorCount: 3 })).toBe(3);
    expect(customMonitorCount({ monitorCount: "4" })).toBe(4);
    expect(customMonitorCount({ monitorCount: 1 })).toBe(2);
    expect(customMonitorCount({ monitorCount: 99 })).toBe(16);
  });
});

describe("layout math", () => {
  it("converts local displays to logical pixels and marks the primary", () => {
    const retina: LocalDisplay = { x: 0, y: 0, width: 3456, height: 2234, scaleFactor: 2 };
    const external: LocalDisplay = { x: 3456, y: 0, width: 2560, height: 1440, scaleFactor: 1 };
    expect(layoutFromLocalDisplays([retina, external], retina)).toEqual([
      { x: 0, y: 0, width: 1728, height: 1117, primary: true, scale: 100 },
      { x: 3456, y: 0, width: 2560, height: 1440, primary: false, scale: 100 },
    ]);
  });

  it("builds a custom row with the first monitor primary", () => {
    expect(customLayout(3, 800, 600).map((m) => [m.x, m.primary])).toEqual([
      [0, true],
      [800, false],
      [1600, false],
    ]);
  });

  it("compares layouts by geometry and primary flag", () => {
    expect(sameLayout([mon(0, 1024, true)], [mon(0, 1024, true)])).toBe(true);
    expect(sameLayout([mon(0, 1024, true)], [mon(0, 1024, false)])).toBe(false);
    expect(sameLayout([mon(0, 1024)], [mon(0, 1024), mon(1024, 1024)])).toBe(false);
  });

  it("offers viewports only for monitors inside the framebuffer", () => {
    const two = [mon(0, 1024, true), mon(1024, 1024)];
    expect(viewportsFor(two, 2048, 768)).toEqual(two);
    // A server that kept one monitor: nothing to select.
    expect(viewportsFor(two, 1024, 768)).toEqual([]);
    expect(viewportsFor([mon(0, 1024, true)], 1024, 768)).toEqual([]);
  });

  it("labels monitors 1-based with size and primary", () => {
    expect(monitorLabel(mon(0, 1024, true), 0)).toBe("Monitor 1 (1024×768, primary)");
    expect(monitorLabel(mon(1024, 1280), 1)).toBe("Monitor 2 (1280×768)");
  });
});

describe("connectMonitorLayout", () => {
  beforeEach(() => {
    mockedAvailable.mockReset();
    mockedPrimary.mockReset();
  });

  it("stamps nothing for a single-monitor connection", async () => {
    expect(await connectMonitorLayout({ host: "h" })).toBeNull();
    expect(mockedAvailable).not.toHaveBeenCalled();
  });

  it("mirrors the local displays in the all mode", async () => {
    const left = tauriMonitor(0, 0, 1920, 1080);
    mockedAvailable.mockResolvedValue([left, tauriMonitor(1920, 0, 1280, 1024)]);
    mockedPrimary.mockResolvedValue(left);
    const layout = await connectMonitorLayout({ monitors: "all" });
    expect(layout?.map((m) => [m.x, m.width, m.primary])).toEqual([
      [0, 1920, true],
      [1920, 1280, false],
    ]);
  });

  it("repeats the primary display size in the custom mode", async () => {
    mockedAvailable.mockResolvedValue([]);
    mockedPrimary.mockResolvedValue(tauriMonitor(0, 0, 2880, 1800, 2));
    const layout = await connectMonitorLayout({ monitors: "custom", monitorCount: 3 });
    expect(layout?.map((m) => [m.x, m.width, m.height])).toEqual([
      [0, 1440, 900],
      [1440, 1440, 900],
      [2880, 1440, 900],
    ]);
  });

  it("falls back to 1920x1080 when the display API fails", async () => {
    mockedAvailable.mockRejectedValue(new Error("no monitors"));
    mockedPrimary.mockResolvedValue(null);
    const layout = await connectMonitorLayout({ monitors: "custom" });
    expect(layout?.map((m) => m.width)).toEqual([1920, 1920]);
    expect(await connectMonitorLayout({ monitors: "all" })).toEqual([]);
  });
});
