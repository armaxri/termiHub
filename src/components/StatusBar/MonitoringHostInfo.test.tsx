import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { fakeStats } from "@/test/systemMonitorHarness";
import type { SystemStats } from "@/types/monitoring";
import { MonitoringHostInfo } from "./MonitoringHostInfo";

/** A sample as the Docker stats fallback produces it (#3202). */
function dockerStatsSample(): SystemStats {
  return {
    ...fakeStats("distroless-app"),
    uptimeSeconds: 0,
    loadAverage: [0, 0, 0],
    osInfo: "",
    source: "dockerStats",
    unavailableMetrics: [
      "uptime",
      "loadAverage",
      "disk",
      "swap",
      "perCoreCpu",
      "osInfo",
      "processes",
    ],
    pidsCurrent: 7,
    blockReadBytesPerSec: 2048,
    blockWriteBytesPerSec: 0,
  };
}

describe("MonitoringHostInfo (#3202)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(stats: SystemStats) {
    act(() => root.render(React.createElement(MonitoringHostInfo, { stats })));
  }

  /** Text of the row with `testId`, or `null` when the row is absent. */
  function text(testId: string): string | null {
    return container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;
  }

  it("renders /proc samples with their values and no source label", () => {
    render({ ...fakeStats("web-1"), uptimeSeconds: 3_700, loadAverage: [0.5, 0.25, 0.1] });
    expect(text("monitoring-info-source")).toBeNull();
    expect(text("monitoring-info-host")).toBe("web-1");
    expect(text("monitoring-info-uptime")).toBe("1h 1m");
    expect(text("monitoring-info-load")).toBe("0.50 0.25 0.10");
    expect(text("monitoring-info-pids")).toBeNull();
    expect(text("monitoring-info-block-io")).toBeNull();
  });

  it("labels a Docker stats sample and shows its gaps as unavailable, not zero", () => {
    render(dockerStatsSample());
    expect(text("monitoring-info-source")).toBe("via Docker stats");
    expect(text("monitoring-info-host")).toBe("distroless-app");
    expect(text("monitoring-info-os")).toBe("Unavailable");
    expect(text("monitoring-info-uptime")).toBe("Unavailable");
    expect(text("monitoring-info-load")).toBe("Unavailable");
  });

  it("shows the Docker stats PID count and block I/O rates", () => {
    render(dockerStatsSample());
    expect(text("monitoring-info-pids")).toBe("7");
    const blockIo = text("monitoring-info-block-io") ?? "";
    expect(blockIo).toContain("↓2");
    expect(blockIo).toContain("↑0 B/s");
  });
});
