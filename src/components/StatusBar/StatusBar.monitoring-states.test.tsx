/**
 * Tests for the host-monitoring states and host menu wording (#5840):
 *
 * - Pause and Stop each say what they do, and Stop uses a stop icon, not the
 *   empty-checkbox square that read as an unticked option (R-039).
 * - A connected monitor with no sample says whether it is waiting, failing or
 *   unsupported, instead of a bare host chip (R-040).
 * - The menu is headed by the host as configured; the resolved hostname is a
 *   muted detail (R-099).
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
import { PAUSE_DESCRIPTION, STOP_DESCRIPTION } from "./StatusBar";
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

describe("StatusBar — monitoring states and host menu (#5840)", () => {
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

  it("explains Pause and Stop in a description line each", async () => {
    liveMonitor();
    await renderStatusBar();
    openMenu();

    const pause = q("monitoring-pause-btn")!;
    expect(pause.querySelector(".ui-menu__title")!.textContent).toBe("Pause monitoring");
    expect(pause.querySelector(".ui-menu__description")!.textContent).toBe(PAUSE_DESCRIPTION);
    const stop = q("monitoring-stop")!;
    expect(stop.querySelector(".ui-menu__title")!.textContent).toBe("Stop monitoring");
    expect(stop.querySelector(".ui-menu__description")!.textContent).toBe(STOP_DESCRIPTION);
    expect(PAUSE_DESCRIPTION).not.toBe(STOP_DESCRIPTION);
  });

  it("gives Stop a stop icon, not the empty square", async () => {
    liveMonitor();
    await renderStatusBar();
    openMenu();

    const icon = q("monitoring-stop")!.querySelector("svg")!;
    expect(icon.getAttribute("class")).toContain("lucide-circle-stop");
    expect(icon.getAttribute("class")).not.toMatch(/lucide-square\b/);
  });

  it("heads the menu with the configured host and mutes the resolved hostname", async () => {
    setMonitor({
      monitorSessionId: KEY,
      host: "127.0.0.1",
      stats: fakeStats("222524db-box.fritz.box", 30),
      sampleCount: 3,
    });
    await renderStatusBar();
    expect(q("monitoring-host")!.textContent).toBe("127.0.0.1");
    openMenu();

    expect(q("monitoring-menu-host")!.textContent).toBe("127.0.0.1");
    const resolved = q("monitoring-info-host")!;
    expect(resolved.textContent).toBe("222524db-box.fritz.box");
    expect(resolved.className).toContain("monitoring-menu__value--muted");
  });

  it("leaves out the hostname row when it is the configured name", async () => {
    setMonitor({ monitorSessionId: KEY, host: "web-1", stats: fakeStats("web-1"), sampleCount: 3 });
    await renderStatusBar();
    openMenu();
    expect(q("monitoring-menu-host")!.textContent).toBe("web-1");
    expect(q("monitoring-info-host")).toBeNull();
  });

  it("says it is waiting for the first reading", async () => {
    setMonitor({ monitorSessionId: KEY, stats: null, sampleCount: 0, status: "connecting" });
    await renderStatusBar();

    expect(q("monitoring-waiting")!.textContent).toContain("Waiting for stats");
    expect(q("monitoring-unavailable")).toBeNull();
    expect(q("monitoring-unsupported")).toBeNull();
  });

  it("shows a muted 'Monitoring unavailable' with the reason when collects fail", async () => {
    setMonitor({
      monitorSessionId: KEY,
      stats: null,
      sampleCount: 0,
      status: "stale",
      statusReason: "parse",
    });
    await renderStatusBar();

    const chip = q("monitoring-unavailable")!;
    expect(chip.textContent).toContain("Monitoring unavailable");
    expect(chip.getAttribute("title")).toContain("remote output unreadable");
    expect(chip.className).not.toContain("monitoring-status__error");
    expect(q("monitoring-waiting")).toBeNull();
    // The reason shows without hovering, and Retry is one click away (states-1).
    expect(chip.textContent).toContain("remote output unreadable");
    const clearMonitoringError = vi.fn();
    useAppStore.setState({ clearMonitoringError });
    const retry = q("monitoring-unavailable-retry") as HTMLButtonElement;
    expect(retry.tagName).toBe("BUTTON");
    expect(retry.textContent).toContain("Retry");
    act(() => retry.click());
    expect(clearMonitoringError).toHaveBeenCalledWith(KEY);
  });

  it("shows unsupported as soon as the host reports no stats source", async () => {
    setMonitor({
      monitorSessionId: KEY,
      stats: null,
      sampleCount: 0,
      status: "stale",
      statusReason: "unsupported",
    });
    await renderStatusBar();
    expect(q("monitoring-unsupported")).not.toBeNull();
    expect(q("monitoring-unavailable")).toBeNull();
    // Why, in a few words, and a way to try again (states-1).
    expect(q("monitoring-unsupported")!.textContent).toContain("no shell for stats on this host");
    expect(q("monitoring-unsupported-retry")?.tagName).toBe("BUTTON");
  });

  it("adds no state chip once stats arrive", async () => {
    liveMonitor();
    await renderStatusBar();
    expect(q("monitoring-waiting")).toBeNull();
    expect(q("monitoring-unavailable")).toBeNull();
    expect(q("monitoring-cpu")).not.toBeNull();
  });
});
