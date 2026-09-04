/**
 * Tests for the CPU first-sample priming indicator (audit gap G10, issue #1148).
 *
 * The remote collectors return CPU 0% on the very first sample because there is
 * no prior delta to compute a rate from (documented in `session.rs` /
 * `agent/collector.rs`). Rendering a solid "CPU 0%" makes that placeholder look
 * like a real reading. Until the second sample has arrived, the status-bar CPU
 * stat shows a priming indicator ("—") instead of the fake "0%".
 *
 * These tests drive the store's `monitoringSampleCount` signal directly to
 * assert the render branch: sample #1 → priming; sample #2 onward → real value.
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

describe("StatusBar — CPU first-sample priming (#1148, G10)", () => {
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

  function renderStatusBar() {
    act(() =>
      root.render(React.createElement(TooltipProvider, null, React.createElement(StatusBar)))
    );
  }

  it("shows a priming indicator (not '0%') for CPU on the first sample", () => {
    setActiveMonitor({
      monitorSessionId: "sess-1",
      stats: makeStats({ cpuUsagePercent: 0 }),
      sampleCount: 1,
      status: "live",
    });
    renderStatusBar();

    const cpu = container.querySelector('[data-testid="monitoring-cpu"]');
    expect(cpu).not.toBeNull();
    expect(cpu!.textContent).not.toContain("0%");
    expect(cpu!.textContent).toContain("—");
    // Memory and disk are correct on the first sample and stay numeric.
    const mem = container.querySelector('[data-testid="monitoring-mem"]');
    expect(mem!.textContent).toContain("50%");
  });

  it("shows the real CPU value from the second sample onward", () => {
    setActiveMonitor({
      monitorSessionId: "sess-1",
      stats: makeStats({ cpuUsagePercent: 42 }),
      sampleCount: 2,
      status: "live",
    });
    renderStatusBar();

    const cpu = container.querySelector('[data-testid="monitoring-cpu"]');
    expect(cpu).not.toBeNull();
    expect(cpu!.textContent).toContain("42%");
    expect(cpu!.textContent).not.toContain("—");
  });
});
