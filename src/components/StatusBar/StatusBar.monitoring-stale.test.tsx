/**
 * Tests for the status-bar Stale indicator (issue #1229, audit gap G1).
 *
 * When the monitoring transport drops mid-stream the collector loop reports a
 * `stale` status. The status bar must stop rendering the frozen numbers as
 * "live": it shows a warning "Stale" badge and dims the stats. Once monitoring
 * recovers (`live`), the badge disappears and the stats un-dim.
 *
 * These tests drive the store's `monitoringStatus` signal directly and assert
 * the render branch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TooltipProvider } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
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

vi.mock("@/components/CredentialStoreIndicator", () => ({ CredentialStoreIndicator: () => null }));
vi.mock("./PortableBadge", () => ({ PortableBadge: () => null }));
vi.mock("./UpdateIndicator", () => ({ UpdateIndicator: () => null }));

function makeStats(overrides: Partial<SystemStats> = {}): SystemStats {
  return {
    hostname: "host",
    uptimeSeconds: 100,
    loadAverage: [0, 0, 0],
    cpuUsagePercent: 30,
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

  useAppStore.setState((state) => ({
    connectionTypes: [sshType],
    settings: { ...state.settings, powerMonitoringEnabled: true },
    rootPanel: leaf,
    activePanelId: "leaf-1",
  }));
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

describe("StatusBar — monitoring Stale indicator (#1229, G1)", () => {
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

  it("shows a Stale badge and dims the stats when status is 'stale'", () => {
    setActiveMonitor({
      monitorSessionId: "sess-1",
      stats: makeStats(),
      sampleCount: 3,
      status: "stale",
    });
    renderStatusBar();

    // The Stale badge is present.
    const badge = container.querySelector('[data-testid="monitoring-stale"]');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain("Stale");

    // The numbers are still shown (frozen) but dimmed via the stale modifier.
    const cpu = container.querySelector('[data-testid="monitoring-cpu"]');
    expect(cpu).not.toBeNull();
    expect(cpu!.className).toContain("monitoring-status__stat--stale");
  });

  it("does not show the Stale badge when status is 'live'", () => {
    setActiveMonitor({
      monitorSessionId: "sess-1",
      stats: makeStats(),
      sampleCount: 3,
      status: "live",
    });
    renderStatusBar();

    expect(container.querySelector('[data-testid="monitoring-stale"]')).toBeNull();
    const cpu = container.querySelector('[data-testid="monitoring-cpu"]');
    expect(cpu!.className).not.toContain("monitoring-status__stat--stale");
  });
});
