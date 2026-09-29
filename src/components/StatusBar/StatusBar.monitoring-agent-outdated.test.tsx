/**
 * The status bar for an agent-hosted session whose agent is too old to monitor
 * it (#3871): the backend fails the subscribe with the `agent_outdated` code,
 * and the status bar says to update the agent — no generic "Monitor error",
 * and no Retry that could only fail again.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TooltipProvider } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { seedLayoutState } from "@/test/layoutState";
import { StatusBar } from "./StatusBar";
import type { ConnectionTypeInfo } from "@/types/connection";
import type { LeafPanel, TerminalTab } from "@/types/terminal";
import type { MonitoringEntry } from "@/types/monitoring";
import { ensureMonitorsSubscribed } from "@/store/systemMonitorBridge";
import {
  fakeMonitor,
  installMonitorHarness,
  monitorsView,
  type FakeMonitorTransport,
} from "@/test/systemMonitorHarness";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { flushAsync } from "@/test/flushAsync";

vi.mock("@/components/CredentialStoreIndicator", () => ({ CredentialStoreIndicator: () => null }));
vi.mock("./PortableBadge", () => ({ PortableBadge: () => null }));
vi.mock("./UpdateIndicator", () => ({ UpdateIndicator: () => null }));

setupSettingsRegion();

const SSH_TYPE: ConnectionTypeInfo = {
  typeId: "ssh",
  displayName: "SSH",
  icon: "server",
  schema: { groups: [] } as unknown as ConnectionTypeInfo["schema"],
  capabilities: { monitoring: true, fileBrowser: true, resize: true, persistent: false },
};

/** Registers a monitoring-capable SSH type and makes an SSH tab active. */
function primeMonitoringTab() {
  const tab: TerminalTab = {
    id: "tab-1",
    sessionId: "sess-1",
    title: "ssh-host",
    connectionType: "ssh",
    contentType: "terminal",
    config: { type: "ssh", config: { host: "pi.local", port: 22, username: "pi" } },
    panelId: "leaf-1",
    isActive: true,
  };

  const leaf: LeafPanel = {
    type: "leaf",
    id: "leaf-1",
    tabs: [tab],
    activeTabId: "tab-1",
  };

  useAppStore.setState({ connectionTypes: [SSH_TYPE] });
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

describe("StatusBar — outdated agent (#3871)", () => {
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

  const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`);

  it("says to update the agent instead of showing a monitor error", async () => {
    setActiveMonitor({
      error:
        "Remote agent error: [thub-code:agent_outdated] the remote agent is too old to monitor this session; update the agent",
    });
    useAppStore.setState({ connectMonitoring: vi.fn(() => Promise.resolve()) });
    await renderStatusBar();

    const notice = byTestId("monitoring-agent-outdated");
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain("Update agent");
    expect(notice?.getAttribute("title")).not.toContain("thub-code");
    expect(byTestId("monitoring-error")).toBeNull();
    expect(byTestId("monitoring-retry-btn")).toBeNull();
  });

  it("keeps the generic error and Retry for any other failure", async () => {
    setActiveMonitor({ error: "Remote agent error: connection refused" });
    useAppStore.setState({ connectMonitoring: vi.fn(() => Promise.resolve()) });
    await renderStatusBar();

    expect(byTestId("monitoring-agent-outdated")).toBeNull();
    expect(byTestId("monitoring-error")).not.toBeNull();
    expect(byTestId("monitoring-retry-btn")).not.toBeNull();
  });
});
