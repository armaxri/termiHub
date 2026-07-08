/**
 * Tests for the monitoring auto-connect feedback gaps (issue #1148, G7 + G8 + G9).
 *
 * G7 — auto-connect failure is a dead-end: the error state must expose a visible
 *      Retry control that clears the failed-host latch and re-invokes connect.
 * G8 — cancelling the password prompt during auto-connect leaves no feedback: a
 *      subtle "Monitoring not connected" affordance with a reachable Retry must
 *      appear when `monitoringCancelled` is set.
 * G9 — a stale `monitoringError` must not linger; the Retry control clears it.
 *
 * These tests drive the store's monitoring signals directly and assert the
 * disconnected-state render branch and the Retry interaction.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TooltipProvider } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { StatusBar } from "./StatusBar";
import type { ConnectionTypeInfo, SavedConnection } from "@/types/connection";
import type { LeafPanel, TerminalTab } from "@/types/terminal";
import type { MonitoringEntry } from "@/types/monitoring";

vi.mock("@/components/CredentialStoreIndicator", () => ({ CredentialStoreIndicator: () => null }));
vi.mock("./PortableBadge", () => ({ PortableBadge: () => null }));
vi.mock("./UpdateIndicator", () => ({ UpdateIndicator: () => null }));

const SSH_TYPE: ConnectionTypeInfo = {
  typeId: "ssh",
  displayName: "SSH",
  icon: "server",
  schema: { groups: [] } as unknown as ConnectionTypeInfo["schema"],
  capabilities: { monitoring: true, fileBrowser: true, resize: true, persistent: false },
};

const SAVED_CONNECTION: SavedConnection = {
  id: "conn-1",
  name: "pi",
  folderId: null,
  config: {
    type: "ssh",
    config: { host: "pi.local", port: 22, username: "pi", authMethod: "key" },
  },
};

/** Registers a monitoring-capable SSH type + saved connection and makes an SSH tab active. */
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

  useAppStore.setState((state) => ({
    connectionTypes: [SSH_TYPE],
    connections: [SAVED_CONNECTION],
    settings: { ...state.settings, powerMonitoringEnabled: true },
    rootPanel: leaf,
    activePanelId: "leaf-1",
  }));
}

/** MonitorKey for the primed SSH tab (`user@host:port`). */
const MONITOR_KEY = "pi@pi.local:22";

/** Install a keyed monitor entry for the primed tab (#1231, per-host slice). */
function setActiveMonitor(patch: Partial<MonitoringEntry>) {
  useAppStore.setState((s) => ({
    monitors: {
      ...s.monitors,
      [MONITOR_KEY]: {
        key: MONITOR_KEY,
        host: MONITOR_KEY,
        sessionBased: false,
        monitorSessionId: null,
        stats: null,
        loading: false,
        error: null,
        status: null,
        sampleCount: 0,
        cancelled: false,
        paused: false,
        intervalMs: 2000,
        ...patch,
      },
    },
  }));
}

describe("StatusBar — monitoring auto-connect feedback (#1148, G7/G8/G9)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    primeMonitoringTab();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
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
    expect(useAppStore.getState().monitors[MONITOR_KEY].error).toBeNull();
    // …and a fresh connect attempt must be made (G7).
    expect(connectSpy.mock.calls.length).toBe(before + 1);
  });

  it("(G8) shows a 'not connected' affordance with Retry when the password prompt was cancelled", () => {
    setActiveMonitor({ cancelled: true });
    useAppStore.setState({ connectMonitoring: vi.fn(() => Promise.resolve()) });
    renderStatusBar();

    const notConnected = container.querySelector('[data-testid="monitoring-not-connected"]');
    expect(notConnected).not.toBeNull();
    expect(notConnected!.textContent).toContain("not connected");

    const retry = container.querySelector('[data-testid="monitoring-retry-btn"]');
    expect(retry).not.toBeNull();
  });

  it("(G8) Retry from the cancelled affordance clears the flag and re-invokes connect", async () => {
    const connectSpy = vi.fn(() => Promise.resolve());
    setActiveMonitor({ cancelled: true });
    useAppStore.setState({ connectMonitoring: connectSpy });
    renderStatusBar();
    await act(async () => {
      await Promise.resolve();
    });

    const retry = container.querySelector<HTMLButtonElement>(
      '[data-testid="monitoring-retry-btn"]'
    );
    const before = connectSpy.mock.calls.length;
    await act(async () => {
      retry!.click();
      await Promise.resolve();
    });

    expect(useAppStore.getState().monitors[MONITOR_KEY].cancelled).toBe(false);
    expect(connectSpy.mock.calls.length).toBe(before + 1);
  });
});
