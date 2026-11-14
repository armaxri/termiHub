/**
 * Tests for stopping host monitoring from the status bar, the compact host menu
 * and the unsupported-host state (#5628).
 *
 * Stopping used to drop the region entry, which re-armed the auto-connect
 * effect: monitoring silently restarted from the cached sample, so Mem / Disk /
 * Swap / Net stayed in the status bar (CPU only vanished while it re-primed).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TooltipProvider } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { seedLayoutState } from "@/test/layoutState";
import { StatusBar } from "./StatusBar";
import type { MonitoringEntry } from "@/types/monitoring";
import type { ConnectionTypeInfo } from "@/types/connection";
import type { LeafPanel, TerminalTab } from "@/types/terminal";
import { ensureMonitorsSubscribed } from "@/store/systemMonitorBridge";
import {
  fakeMonitor,
  fakeStats,
  installMonitorHarness,
  monitorsView,
  type FakeMonitorTransport,
} from "@/test/systemMonitorHarness";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { flushAsync } from "@/test/flushAsync";

vi.mock("@/components/CredentialStoreIndicator", () => ({ CredentialStoreIndicator: () => null }));
vi.mock("./PortableBadge", () => ({ PortableBadge: () => null }));
vi.mock("./UpdateIndicator", () => ({ UpdateIndicator: () => null }));
// uPlot needs a real canvas; the sparkline itself is covered by its own suite.
vi.mock("./MetricSparkline", () => ({
  MetricSparkline: ({ ariaLabel }: { ariaLabel: string }) =>
    React.createElement("div", { "data-testid": "spark", "aria-label": ariaLabel }),
}));

setupSettingsRegion();

const KEY = "sess-1";
const METRIC_CHIPS = ["cpu", "mem", "disk", "swap", "net"];

let transport: FakeMonitorTransport;
let teardownMonitors: () => void;

function primeSshTab() {
  const sshType: ConnectionTypeInfo = {
    typeId: "ssh",
    displayName: "SSH",
    icon: "server",
    schema: { groups: [] } as unknown as ConnectionTypeInfo["schema"],
    capabilities: { monitoring: true, fileBrowser: true, resize: true, persistent: false },
  };
  const tab: TerminalTab = {
    id: "tab-1",
    sessionId: KEY,
    title: "ssh-host",
    connectionType: "ssh",
    contentType: "terminal",
    config: { type: "ssh", config: { host: "host", port: 22, username: "user" } },
    panelId: "leaf-1",
    isActive: true,
  };
  const leaf: LeafPanel = { type: "leaf", id: "leaf-1", tabs: [tab], activeTabId: "tab-1" };
  useAppStore.setState({ connectionTypes: [sshType] });
  seedLayoutState({ rootPanel: leaf, activePanelId: "leaf-1" });
  // Every chip, swap included (#5754), so the stop proves all of them go.
  seedSettings({
    powerMonitoringEnabled: true,
    statusBarMetrics: ["cpu", "memory", "disk", "swap", "network"],
  });
}

function setMonitor(patch: Partial<MonitoringEntry> | null) {
  transport.seed(monitorsView(patch ? [fakeMonitor(KEY, { host: KEY, ...patch })] : []));
}

function liveMonitor() {
  setMonitor({ monitorSessionId: KEY, stats: fakeStats("host", 30), sampleCount: 3 });
}

describe("StatusBar — stop monitoring, compact menu, unsupported host (#5628)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let connectMonitoring: ReturnType<
    typeof vi.fn<(key: string, host?: string | null) => Promise<void>>
  >;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    primeSshTab();
    ({ transport, teardown: teardownMonitors } = installMonitorHarness());
    await ensureMonitorsSubscribed();
    connectMonitoring = vi.fn((_key: string, _host?: string | null) => Promise.resolve());
    // The backend close drops the region entry (it keeps only the stats cache).
    const disconnectMonitoring = vi.fn(async () => setMonitor(null));
    useAppStore.setState({ connectMonitoring, disconnectMonitoring });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    teardownMonitors();
  });

  async function renderStatusBar() {
    await act(async () => {
      root.render(React.createElement(TooltipProvider, null, React.createElement(StatusBar)));
    });
    await flushAsync();
  }

  function q(testId: string): Element | null {
    return document.body.querySelector(`[data-testid="${testId}"]`);
  }

  function openMenu() {
    act(() => {
      q("monitoring-host")!.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false })
      );
    });
  }

  async function clickStop() {
    openMenu();
    const item = q("monitoring-stop");
    expect(item).not.toBeNull();
    await act(async () => {
      item!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushAsync();
  }

  it("removes every metric chip after Stop monitoring and does not reconnect", async () => {
    liveMonitor();
    await renderStatusBar();
    for (const chip of METRIC_CHIPS) expect(q(`monitoring-${chip}`)).not.toBeNull();

    await clickStop();

    for (const chip of METRIC_CHIPS) expect(q(`monitoring-${chip}`)).toBeNull();
    expect(q("monitoring-host")).toBeNull();
    expect(connectMonitoring).not.toHaveBeenCalled();
    const stopped = q("monitoring-stopped");
    expect(stopped).not.toBeNull();
    expect(stopped!.textContent).toContain("Monitoring off");
    expect(stopped!.textContent).toContain("Start monitoring");
  });

  it('labels the menu item "Stop monitoring", not "Disconnect" (#5750)', async () => {
    liveMonitor();
    await renderStatusBar();
    openMenu();
    const item = q("monitoring-stop");
    expect(item!.textContent).toBe("Stop monitoring");
    expect(document.body.textContent).not.toContain("Disconnect");
  });

  it("keeps the chips hidden even before the backend drops the entry", async () => {
    liveMonitor();
    useAppStore.setState({ disconnectMonitoring: vi.fn(() => new Promise<void>(() => {})) });
    await renderStatusBar();

    await clickStop();

    for (const chip of METRIC_CHIPS) expect(q(`monitoring-${chip}`)).toBeNull();
    expect(q("monitoring-stopped")).not.toBeNull();
  });

  it("restarts monitoring from the Start affordance", async () => {
    liveMonitor();
    await renderStatusBar();
    await clickStop();

    await act(async () => {
      q("monitoring-start-btn")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushAsync();

    expect(connectMonitoring).toHaveBeenCalledWith(KEY, "host");
    expect(q("monitoring-stopped")).toBeNull();
  });

  it("shows one compact row per metric, Disk included", async () => {
    liveMonitor();
    await renderStatusBar();
    openMenu();

    for (const key of ["cpu", "memory", "disk", "swap", "netRx", "netTx"]) {
      expect(q(`monitoring-metric-${key}`)).not.toBeNull();
    }
    expect(q("monitoring-metric-disk")!.textContent).toContain("40%");
  });

  it("folds the refresh interval into one submenu trigger", async () => {
    liveMonitor();
    await renderStatusBar();
    openMenu();

    const trigger = q("monitoring-refresh-trigger");
    expect(trigger).not.toBeNull();
    expect(trigger!.textContent).toContain("Refresh: 2 s");
    // The options live in the submenu, not inline in the host menu.
    expect(q("monitoring-interval-1000")).toBeNull();
    expect(document.body.textContent).not.toContain("Refresh every");
  });

  it("shows an unsupported host as muted info without Retry", async () => {
    setMonitor({
      monitorSessionId: KEY,
      stats: null,
      sampleCount: 0,
      status: "offline",
      statusReason: "unsupported",
    });
    await renderStatusBar();

    const info = q("monitoring-unsupported");
    expect(info).not.toBeNull();
    expect(info!.textContent).toContain("Monitoring unavailable");
    expect(info!.className).not.toContain("monitoring-status__error");
    expect(info!.getAttribute("title") ?? info!.getAttribute("aria-label")).toMatch(/sh/);
    expect(q("monitoring-retry-btn")).toBeNull();

    openMenu();
    expect(q("monitoring-retry-btn")).toBeNull();
  });

  it("still offers Retry for a transient offline state", async () => {
    setMonitor({
      monitorSessionId: KEY,
      stats: fakeStats("host"),
      sampleCount: 3,
      status: "offline",
      statusReason: "transport",
    });
    await renderStatusBar();
    expect(q("monitoring-retry-btn")).not.toBeNull();
    expect(q("monitoring-unsupported")).toBeNull();
  });
});
