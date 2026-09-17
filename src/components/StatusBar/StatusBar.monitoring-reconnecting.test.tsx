/**
 * Tests for the status-bar Reconnecting indicator (audit finding SM-014).
 *
 * When a mid-stream transport drop moves the collector loop into a bounded
 * reconnect campaign it reports a `reconnecting` status (core
 * `MonitorStatus::Reconnecting`, driven by the agent loop's `begin_reconnect`).
 * Until this fix the status bar had no arm for it: the frozen last-known numbers
 * were rendered at full opacity with no indication they were no longer live.
 *
 * The status bar must now show a "Reconnecting…" badge and dim the stats — the
 * same "frozen, not live" treatment as `stale` — so the user knows the numbers
 * are not live while the transport is re-dialled. Once monitoring recovers
 * (`live`) the badge disappears and the stats un-dim.
 *
 * These tests drive the store's monitoring status signal directly and assert the
 * render branch.
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

describe("StatusBar — monitoring Reconnecting indicator (SM-014)", () => {
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

  it("shows a Reconnecting badge and dims the stats when status is 'reconnecting'", () => {
    setActiveMonitor({
      monitorSessionId: "sess-1",
      stats: makeStats(),
      sampleCount: 3,
      status: "reconnecting",
    });
    renderStatusBar();

    // The Reconnecting badge is present.
    const badge = container.querySelector('[data-testid="monitoring-reconnecting"]');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain("Reconnecting");

    // The numbers are still shown (frozen) but dimmed via the stale modifier.
    const cpu = container.querySelector('[data-testid="monitoring-cpu"]');
    expect(cpu).not.toBeNull();
    expect(cpu!.className).toContain("monitoring-status__stat--stale");

    const mem = container.querySelector('[data-testid="monitoring-mem"]');
    expect(mem!.className).toContain("monitoring-status__stat--stale");
    const disk = container.querySelector('[data-testid="monitoring-disk"]');
    expect(disk!.className).toContain("monitoring-status__stat--stale");
  });

  it("does not show the Reconnecting badge when status is 'live'", () => {
    setActiveMonitor({
      monitorSessionId: "sess-1",
      stats: makeStats(),
      sampleCount: 3,
      status: "live",
    });
    renderStatusBar();

    expect(container.querySelector('[data-testid="monitoring-reconnecting"]')).toBeNull();
    const cpu = container.querySelector('[data-testid="monitoring-cpu"]');
    expect(cpu!.className).not.toContain("monitoring-status__stat--stale");
  });

  it("does not show the Reconnecting badge when status is 'stale'", () => {
    setActiveMonitor({
      monitorSessionId: "sess-1",
      stats: makeStats(),
      sampleCount: 3,
      status: "stale",
    });
    renderStatusBar();

    // Stale is its own arm; the reconnecting badge must not also appear.
    expect(container.querySelector('[data-testid="monitoring-reconnecting"]')).toBeNull();
    expect(container.querySelector('[data-testid="monitoring-stale"]')).not.toBeNull();
  });
});
