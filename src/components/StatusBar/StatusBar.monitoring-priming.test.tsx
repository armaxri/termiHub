/**
 * Tests for the CPU first-sample priming indicator (audit gap G10, issue #1148).
 *
 * The remote collectors return CPU 0% on the very first sample because there is
 * no prior delta to compute a rate from (documented in `session.rs` /
 * `agent/collector.rs`). Rendering a solid "CPU 0%" makes that placeholder look
 * like a real reading. Until the second sample has arrived, the status-bar CPU
 * stat is hidden (#5563) — the earlier "CPU —" placeholder read as an error.
 *
 * These tests drive the store's `monitoringSampleCount` signal directly to
 * assert the render branch: sample #1 → hidden; sample #2 onward → real value.
 *
 * The same harness also covers the rest of the #5563 polish: the stats sit in
 * one labelled host group ("This computer" for a local shell), and are coloured
 * only past the actionable thresholds.
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
import { flushAsync } from "@/test/flushAsync";

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
    swapTotalKb: 2000,
    swapUsedKb: 500,
    swapUsedPercent: 25,
    netRxBytesPerSec: 1024,
    netTxBytesPerSec: 512,
    perCoreCpuPercent: [10, 90],
    ...overrides,
  };
}

/** Registers a monitoring-capable type and makes a tab of it the active tab (SSH by default). */
function primeMonitoringTab(kind: "ssh" | "local" = "ssh") {
  const sshType: ConnectionTypeInfo = {
    typeId: kind,
    displayName: kind === "ssh" ? "SSH" : "Local shell",
    icon: "server",
    schema: { groups: [] } as unknown as ConnectionTypeInfo["schema"],
    capabilities: { monitoring: true, fileBrowser: true, resize: true, persistent: false },
  };

  const tab: TerminalTab = {
    id: "tab-1",
    sessionId: "sess-1",
    title: kind === "ssh" ? "ssh-host" : "Startup question (zsh)",
    connectionType: kind,
    contentType: "terminal",
    config:
      kind === "ssh"
        ? { type: "ssh", config: { host: "host", port: 22, username: "user" } }
        : { type: "local", config: { shell: "zsh" } },
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
  // An opted-in user (#5754): local shells monitored and every chip, swap included.
  seedSettings({
    powerMonitoringEnabled: true,
    monitorLocalShells: true,
    statusBarMetrics: ["cpu", "memory", "disk", "swap", "network"],
  });
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

  async function renderStatusBar() {
    await act(async () => {
      root.render(React.createElement(TooltipProvider, null, React.createElement(StatusBar)));
    });
    await flushAsync();
  }

  it("hides CPU (no fake '0%', no '—') until the second sample (#5563)", async () => {
    setActiveMonitor({
      monitorSessionId: "sess-1",
      stats: makeStats({ cpuUsagePercent: 0 }),
      sampleCount: 1,
      status: "live",
    });
    await renderStatusBar();

    expect(container.querySelector('[data-testid="monitoring-cpu"]')).toBeNull();
    expect(container.textContent).not.toContain("CPU");
    // Memory and disk are correct on the first sample and stay numeric.
    const mem = container.querySelector('[data-testid="monitoring-mem"]');
    expect(mem!.textContent).toContain("50%");
  });

  it("shows the real CPU value from the second sample onward", async () => {
    setActiveMonitor({
      monitorSessionId: "sess-1",
      stats: makeStats({ cpuUsagePercent: 42 }),
      sampleCount: 2,
      status: "live",
    });
    await renderStatusBar();

    const cpu = container.querySelector('[data-testid="monitoring-cpu"]');
    expect(cpu).not.toBeNull();
    expect(cpu!.textContent).toContain("42%");
    expect(cpu!.textContent).not.toContain("—");
  });
});

describe("StatusBar — host stats group and colouring (#5563)", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function setup(kind: "ssh" | "local", stats: Partial<SystemStats> = {}) {
    useAppStore.setState(useAppStore.getInitialState());
    primeMonitoringTab(kind);
    ({ transport, teardown: teardownMonitors } = installMonitorHarness());
    await ensureMonitorsSubscribed();
    useAppStore.setState({ connectMonitoring: vi.fn(() => Promise.resolve()) });
    setActiveMonitor({
      host: kind === "ssh" ? "host" : "Startup question (zsh)",
      monitorSessionId: "sess-1",
      stats: makeStats({ cpuUsagePercent: 12, ...stats }),
      sampleCount: 3,
      status: "live",
    });
    await act(async () => {
      root.render(React.createElement(TooltipProvider, null, React.createElement(StatusBar)));
    });
    await flushAsync();
  }

  const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    teardownMonitors();
  });

  it("names a local shell's host 'This computer', not the tab title", async () => {
    await setup("local");
    const group = byTestId("monitoring-group")!;
    expect(group.getAttribute("role")).toBe("group");
    expect(group.getAttribute("aria-label")).toBe("Host stats: This computer");
    expect(byTestId("monitoring-host")!.textContent).toBe("This computer");
    expect(group.textContent).not.toContain("Startup question");
  });

  it("names a remote tab's group by its hostname", async () => {
    await setup("ssh");
    expect(byTestId("monitoring-group")!.getAttribute("aria-label")).toBe("Host stats: host");
    expect(byTestId("monitoring-host")!.textContent).toBe("host");
  });

  it("keeps every stat inside the group", async () => {
    await setup("local");
    const group = byTestId("monitoring-group")!;
    for (const id of ["monitoring-cpu", "monitoring-mem", "monitoring-disk", "monitoring-swap"]) {
      expect(group.contains(byTestId(id)), id).toBe(true);
    }
  });

  it("leaves idle-machine values (e.g. disk 78%, swap 82%) uncoloured", async () => {
    await setup("local", { memoryUsedPercent: 59, diskUsedPercent: 78, swapUsedPercent: 82 });
    for (const id of ["monitoring-mem", "monitoring-disk", "monitoring-swap"]) {
      expect(byTestId(id)!.className, id).toContain("monitoring-status__stat--normal");
    }
  });

  it("colours only past the actionable thresholds (warning ≥ 90%, critical ≥ 95%)", async () => {
    await setup("local", { diskUsedPercent: 91, swapUsedPercent: 97 });
    expect(byTestId("monitoring-disk")!.className).toContain("monitoring-status__stat--warning");
    expect(byTestId("monitoring-swap")!.className).toContain("monitoring-status__stat--critical");
  });
});
