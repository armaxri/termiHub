/**
 * Tests for the Docker stats fallback rendering in the status bar (#3202).
 *
 * A distroless container is sampled via the Docker Engine stats API, which
 * cannot supply disk, load, uptime, swap, per-core CPU or the process list.
 * Those metrics must render as unavailable ("Disk n/a", a disabled processes
 * entry) — never as a real-looking zero — and the dropdown labels the source.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TooltipProvider } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { seedLayoutState } from "@/test/layoutState";
import { StatusBar } from "./StatusBar";
import type { SystemStats, MonitoringEntry } from "@/types/monitoring";
import { ensureMonitorsSubscribed } from "@/store/systemMonitorBridge";
import {
  fakeMonitor,
  installMonitorHarness,
  monitorsView,
  type FakeMonitorTransport,
} from "@/test/systemMonitorHarness";
import type { ConnectionTypeInfo } from "@/types/connection";
import type { LeafPanel, TerminalTab } from "@/types/terminal";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";

vi.mock("@/components/CredentialStoreIndicator", () => ({ CredentialStoreIndicator: () => null }));
vi.mock("./PortableBadge", () => ({ PortableBadge: () => null }));
vi.mock("./UpdateIndicator", () => ({ UpdateIndicator: () => null }));
// The sparklines draw to a <canvas>, which jsdom does not implement.
vi.mock("./MetricSparkline", () => ({ MetricSparkline: () => null }));

setupSettingsRegion();

function makeStats(overrides: Partial<SystemStats> = {}): SystemStats {
  return {
    hostname: "host",
    uptimeSeconds: 100,
    loadAverage: [0, 0, 0],
    cpuUsagePercent: 0,
    memoryTotalKb: 1000,
    memoryAvailableKb: 500,
    memoryUsedPercent: 50,
    diskTotalKb: 2000,
    diskUsedKb: 1000,
    diskUsedPercent: 50,
    osInfo: "Linux",
    swapTotalKb: 2000,
    swapUsedKb: 500,
    swapUsedPercent: 25,
    netRxBytesPerSec: 1024,
    netTxBytesPerSec: 512,
    perCoreCpuPercent: [10, 90],
    ...overrides,
  };
}

/** Registers a monitoring-capable SSH type and makes an SSH tab the active tab. */
function primeMonitoringTab() {
  const sshType: ConnectionTypeInfo = {
    typeId: "ssh",
    displayName: "SSH",
    icon: "server",
    schema: { groups: [] } as unknown as ConnectionTypeInfo["schema"],
    capabilities: { monitoring: true, fileBrowser: true, resize: true, persistent: false },
  };

  const tab: TerminalTab = {
    id: "tab-1",
    sessionId: "sess-1",
    title: "ssh-host",
    connectionType: "ssh",
    contentType: "terminal",
    config: { type: "ssh", config: { host: "host", port: 22, username: "user" } },
    panelId: "leaf-1",
    isActive: true,
  };

  const leaf: LeafPanel = {
    type: "leaf",
    id: "leaf-1",
    tabs: [tab],
    activeTabId: "tab-1",
  };

  useAppStore.setState({ connectionTypes: [sshType] });
  seedLayoutState({ rootPanel: leaf, activePanelId: "leaf-1" });
  seedSettings({ powerMonitoringEnabled: true });
}

/** MonitorKey for the primed SSH tab: the owning terminal session id (#1232). */
const MONITOR_KEY = "sess-1";

let transport: FakeMonitorTransport;
let teardownMonitors: () => void;

/**
 * Seed the active tab's monitor entry into the authoritative `system-monitors`
 * region (#2224). The bridge is pre-subscribed in `beforeEach`, so this
 * synchronously updates the projected view the component reads on first render.
 */
function setActiveMonitor(patch: Partial<MonitoringEntry>) {
  transport.seed(
    monitorsView([
      fakeMonitor(MONITOR_KEY, {
        host: MONITOR_KEY,
        monitorSessionId: null,
        status: null,
        ...patch,
      }),
    ])
  );
}

function dockerStatsSample(): SystemStats {
  return makeStats({
    hostname: "distroless-app",
    diskTotalKb: 0,
    diskUsedKb: 0,
    diskUsedPercent: 0,
    swapTotalKb: 0,
    swapUsedKb: 0,
    swapUsedPercent: 0,
    perCoreCpuPercent: [],
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
    pidsCurrent: 4,
  });
}

describe("StatusBar — Docker stats fallback (#3202)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    primeMonitoringTab();
    ({ transport, teardown: teardownMonitors } = installMonitorHarness());
    await ensureMonitorsSubscribed();
    useAppStore.setState({ connectMonitoring: vi.fn(() => Promise.resolve()) });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    teardownMonitors();
  });

  function renderWith(stats: SystemStats) {
    setActiveMonitor({ monitorSessionId: "sess-1", stats, sampleCount: 2, status: "live" });
    act(() =>
      root.render(React.createElement(TooltipProvider, null, React.createElement(StatusBar)))
    );
  }

  function openDropdown() {
    const trigger = container.querySelector('[data-testid="monitoring-host"]');
    expect(trigger).not.toBeNull();
    act(() => {
      trigger!.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false })
      );
    });
  }

  it("renders disk as unavailable instead of 0%", () => {
    renderWith(dockerStatsSample());
    const disk = container.querySelector('[data-testid="monitoring-disk"]');
    expect(disk!.textContent).toBe("Disk n/a");
    expect(disk!.getAttribute("title")).toBe("Disk: unavailable via Docker stats");
    expect(container.querySelector('[data-testid="monitoring-swap"]')).toBeNull();
  });

  it("keeps the metrics Docker stats does supply numeric", () => {
    renderWith(dockerStatsSample());
    expect(container.querySelector('[data-testid="monitoring-cpu"]')!.textContent).toBe("CPU 0%");
    expect(container.querySelector('[data-testid="monitoring-mem"]')!.textContent).toBe("Mem 50%");
    expect(container.querySelector('[data-testid="monitoring-net"]')!.textContent).toContain(
      "Net ↓"
    );
  });

  it("renders a missing CPU / memory / network as unavailable too", () => {
    renderWith({
      ...dockerStatsSample(),
      unavailableMetrics: ["cpu", "memory", "network", "disk"],
    });
    for (const [id, text] of [
      ["monitoring-cpu", "CPU n/a"],
      ["monitoring-mem", "Mem n/a"],
      ["monitoring-net", "Net n/a"],
    ]) {
      expect(container.querySelector(`[data-testid="${id}"]`)!.textContent).toBe(text);
    }
  });

  it("labels the source and disables the process list in the dropdown", () => {
    renderWith(dockerStatsSample());
    openDropdown();
    const source = document.body.querySelector('[data-testid="monitoring-info-source"]');
    expect(source?.textContent).toBe("via Docker stats");
    expect(document.body.querySelector('[data-testid="monitoring-processes-open"]')).toBeNull();
    const unavailable = document.body.querySelector(
      '[data-testid="monitoring-processes-unavailable"]'
    );
    expect(unavailable?.textContent).toBe("Processes: unavailable via Docker stats");
    expect(unavailable?.hasAttribute("data-disabled")).toBe(true);
  });

  it("keeps a /proc sample unlabelled with its process list available", () => {
    renderWith(makeStats());
    expect(container.querySelector('[data-testid="monitoring-disk"]')!.textContent).toBe(
      "Disk 50%"
    );
    openDropdown();
    expect(document.body.querySelector('[data-testid="monitoring-info-source"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="monitoring-processes-open"]')).not.toBeNull();
  });
});
