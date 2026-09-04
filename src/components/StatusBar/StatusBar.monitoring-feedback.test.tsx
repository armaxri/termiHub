/**
 * Tests for the monitoring auto-connect feedback gaps (issue #1148, G7 + G9).
 *
 * G7 — auto-connect failure is a dead-end: the error state must expose a visible
 *      Retry control that clears the failed-host latch and re-invokes connect.
 * G9 — a stale `monitoringError` must not linger; the Retry control clears it.
 *
 * (The former G8 "password prompt cancelled" affordance was retired with the
 * legacy pull path in #1232: monitoring now reuses the already-authenticated
 * terminal session, so there is no monitoring-specific credential prompt.)
 *
 * These tests drive the store's monitoring signals directly and assert the
 * disconnected-state render branch and the Retry interaction.
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
import { currentMonitorsView, ensureMonitorsSubscribed } from "@/store/systemMonitorBridge";
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

describe("StatusBar — monitoring auto-connect feedback (#1148, G7/G8/G9)", () => {
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

  function renderStatusBar() {
    act(() =>
      root.render(React.createElement(TooltipProvider, null, React.createElement(StatusBar)))
    );
  }

  it("(G7) shows a Retry control when monitoring is in the error state", () => {
    // A no-op connect prevents the mount auto-connect effect from mutating the
    // error/cancelled state we set up for the render assertions.
    setActiveMonitor({ error: "Connection refused" });
    useAppStore.setState({ connectMonitoring: vi.fn(() => Promise.resolve()) });
    renderStatusBar();

    const err = container.querySelector('[data-testid="monitoring-error"]');
    expect(err).not.toBeNull();

    const retry = container.querySelector('[data-testid="monitoring-retry-btn"]');
    expect(retry).not.toBeNull();
  });

  it("(G7 + G9) Retry clears the lingering error and re-invokes connect", async () => {
    const connectSpy = vi.fn(() => Promise.resolve());
    setActiveMonitor({ error: "Connection refused" });
    useAppStore.setState({ connectMonitoring: connectSpy });
    renderStatusBar();
    // Let any mount auto-connect microtasks settle before counting.
    await act(async () => {
      await Promise.resolve();
    });

    const retry = container.querySelector<HTMLButtonElement>(
      '[data-testid="monitoring-retry-btn"]'
    );
    expect(retry).not.toBeNull();

    // Count connect calls after mount settles (the auto-connect effect may have
    // fired once on mount); Retry must add exactly one fresh attempt.
    const before = connectSpy.mock.calls.length;
    await act(async () => {
      retry!.click();
      await Promise.resolve();
    });

    // The stale error must be cleared so it does not linger (G9)…
    expect(currentMonitorsView().monitors[MONITOR_KEY].error).toBeNull();
    // …and a fresh connect attempt must be made (G7).
    expect(connectSpy.mock.calls.length).toBe(before + 1);
  });
});
