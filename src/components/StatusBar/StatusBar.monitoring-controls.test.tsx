/**
 * Tests for the status-bar monitoring lifecycle controls (issue #1233).
 *
 * The status bar surfaces Pause/Resume, Cancel (while connecting), Retry (when
 * offline), and a per-host refresh-interval selector. These tests drive the
 * store's keyed monitor entry directly and assert the render branches and that
 * the controls invoke the matching store actions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TooltipProvider } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { StatusBar } from "./StatusBar";
import type { SystemStats, MonitoringEntry } from "@/types/monitoring";
import type { ConnectionTypeInfo } from "@/types/connection";
import type { LeafPanel, TerminalTab } from "@/types/terminal";
import { ensureMonitorsSubscribed } from "@/store/systemMonitorBridge";
import {
  fakeMonitor,
  installMonitorHarness,
  monitorsView,
  type FakeMonitorTransport,
} from "@/test/systemMonitorHarness";
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

  useAppStore.setState({
    connectionTypes: [sshType],
    rootPanel: leaf,
    activePanelId: "leaf-1",
  });
  seedSettings({ powerMonitoringEnabled: true });
}

/**
 * Registers a monitoring-capable remote-session type and makes a remote-session
 * tab active. Remote-session tabs auto-connect and surface the loading/Cancel
 * affordance without any saved connections (unlike direct SSH).
 */
function primeRemoteSessionTab(sessionId: string) {
  const type: ConnectionTypeInfo = {
    typeId: "remote-session",
    displayName: "Remote Session",
    icon: "server",
    schema: { groups: [] } as unknown as ConnectionTypeInfo["schema"],
    capabilities: { monitoring: true, fileBrowser: true, resize: true, persistent: true },
  };
  const tab: TerminalTab = {
    id: "tab-rs",
    sessionId,
    title: "remote",
    connectionType: "remote-session",
    contentType: "terminal",
    config: { type: "remote-session", config: {} },
    panelId: "leaf-rs",
    isActive: true,
  };
  const leaf: LeafPanel = { type: "leaf", id: "leaf-rs", tabs: [tab], activeTabId: "tab-rs" };
  useAppStore.setState((state) => ({
    connectionTypes: [type],
    sessionCapabilities: {
      ...state.sessionCapabilities,
      [sessionId]: { monitoring: true, fileBrowser: true },
    },
    rootPanel: leaf,
    activePanelId: "leaf-rs",
  }));
  seedSettings({ powerMonitoringEnabled: true });
}

/** MonitorKey for the primed SSH tab — the owning session id (#1232). */
const MONITOR_KEY = "sess-1";

let transport: FakeMonitorTransport;
let teardownMonitors: () => void;

/**
 * Seed the active tab's monitor entry into the authoritative `system-monitors`
 * region (#2224 — monitor state no longer lives in `appStore`). The bridge is
 * pre-subscribed in `beforeEach`, so this synchronously updates the projected
 * view the component reads on its first render.
 */
function setActiveMonitor(patch: Partial<MonitoringEntry>, key = MONITOR_KEY) {
  transport.seed(
    monitorsView([fakeMonitor(key, { host: key, monitorSessionId: null, status: null, ...patch })])
  );
}

describe("StatusBar — monitoring controls (#1233)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    primeMonitoringTab();
    vi.restoreAllMocks();
    ({ transport, teardown: teardownMonitors } = installMonitorHarness());
    await ensureMonitorsSubscribed();
    // Neutralise the auto-connect effect so it never reaches the real backend
    // command (these tests drive the region + controls directly).
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

  it("shows a Cancel affordance while connecting and calls cancelMonitoring", () => {
    const cancelMonitoring = vi.fn(() => Promise.resolve());
    const SESSION = "sess-connecting";
    // A remote-session tab surfaces the Connecting + Cancel affordance without
    // any saved connections (direct-SSH gates that block behind a picker).
    primeRemoteSessionTab(SESSION);
    useAppStore.setState({ cancelMonitoring });
    setActiveMonitor({ loading: true, status: "connecting" }, SESSION);
    renderStatusBar();

    const cancel = container.querySelector('[data-testid="monitoring-cancel-btn"]');
    expect(cancel).not.toBeNull();

    act(() => {
      cancel!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(cancelMonitoring).toHaveBeenCalledWith(SESSION);
  });

  it("renders a neutral Paused badge and dims the stats when paused", () => {
    setActiveMonitor({
      monitorSessionId: "sess-1",
      stats: makeStats(),
      sampleCount: 3,
      status: "paused",
      paused: true,
    });
    renderStatusBar();

    const badge = container.querySelector('[data-testid="monitoring-paused"]');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain("Paused");

    // Frozen numbers are dimmed via the stale modifier while paused.
    const cpu = container.querySelector('[data-testid="monitoring-cpu"]');
    expect(cpu!.className).toContain("monitoring-status__stat--stale");
  });

  it("shows an inline Retry affordance when the monitor is offline", () => {
    setActiveMonitor({
      monitorSessionId: "sess-1",
      stats: makeStats(),
      sampleCount: 3,
      status: "offline",
    });
    renderStatusBar();

    const retry = container.querySelector('[data-testid="monitoring-retry-btn"]');
    expect(retry).not.toBeNull();
    expect(retry!.textContent).toContain("Retry");
  });

  it("does not render Paused / Retry affordances while live", () => {
    setActiveMonitor({
      monitorSessionId: "sess-1",
      stats: makeStats(),
      sampleCount: 3,
      status: "live",
    });
    renderStatusBar();

    expect(container.querySelector('[data-testid="monitoring-paused"]')).toBeNull();
    expect(container.querySelector('[data-testid="monitoring-retry-btn"]')).toBeNull();
  });
});
