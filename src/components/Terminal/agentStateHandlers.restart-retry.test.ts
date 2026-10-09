/**
 * Tests for {@link restartAgentRetryTabs}: when an agent reconnects, its tabs in
 * a connection-overlay state (auto-retry delay or "Connection failed") restart.
 *
 * The rest of the `agent-state-change` handler is tested through the real
 * {@link handleAgentStateChange} in `agentStateHandlers.agent-state-change.test.ts`
 * (#4309 replaced the hand copies of its loops that used to live here).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAllLeaves } from "@/utils/panelTree";
import { useAppStore } from "@/store/appStore";
import { layoutState } from "@/test/layoutState";
import { setupAgentsRegion } from "@/test/agentsRegionTestHarness";
import { currentSessionView } from "@/store/sessionBridge";
import { installSessionLifecycleHarness } from "@/test/sessionLifecycleRegionTestHarness";
import { restartAgentRetryTabs } from "./agentStateHandlers";

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  persistConnection: vi.fn(() => Promise.resolve()),
  removeConnection: vi.fn(() => Promise.resolve()),
  persistFolder: vi.fn(() => Promise.resolve()),
  removeFolder: vi.fn(() => Promise.resolve()),
  persistAgent: vi.fn(() => Promise.resolve()),
  removeAgent: vi.fn(() => Promise.resolve()),
  reorderAgents: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() =>
    Promise.resolve({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
    })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  moveConnectionToFile: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  connectAgent: vi.fn(),
  disconnectAgent: vi.fn(),
  listAgentSessions: vi.fn(() => Promise.resolve([])),
  listAgentDefinitions: vi.fn(() => Promise.resolve([])),
  listAgentConnections: vi.fn(() => Promise.resolve({ connections: [], folders: [] })),
  saveAgentDefinition: vi.fn(),
  updateAgentDefinition: vi.fn(),
  deleteAgentDefinition: vi.fn(),
  createAgentFolder: vi.fn(),
  updateAgentFolder: vi.fn(),
  deleteAgentFolder: vi.fn(),
  getCredentialStoreStatus: vi.fn(() => Promise.resolve({ mode: "none", status: "unavailable" })),
  sessionGetCapabilities: vi.fn(() => Promise.resolve({ monitoring: false, fileBrowser: false })),
  sessionMonitoringOpen: vi.fn(() => Promise.resolve()),
  sessionMonitoringClose: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

/** Helper: collect all terminal tabs from all panels in the current store state. */
function getAllTerminalTabs() {
  const store = layoutState();
  return store.tabGroups.flatMap((g) => getAllLeaves(g.rootPanel).flatMap((l) => l.tabs));
}

setupAgentsRegion();

// ── 'connected' while tab is in connection-overlay (auto-retry/failure) ─────

/**
 * REGRESSION: When the user clicks "Reconnect" after an agent disconnect, the
 * tab enters the connection-overlay state (auto-retry loop or "Connection
 * failed").  reconnectTerminal cleared terminalReconnectingTabs, so the
 * reconnecting/waiting paths in the "connected" handler never fired.  The
 * auto-retry loop eventually called createTerminal again, but there was no
 * mechanism to wake it immediately when the agent reconnected.
 *
 * Fix: a third loop in the "connected" handler restarts tabs that are in the
 * connection-overlay state by calling reconnectTerminal.
 */
describe("agent-state-change 'connected': restart tabs in auto-retry/failure state", () => {
  // The "actively connecting" gate is region-sourced now (#2205 PR-B): the handler
  // reads the projected `connecting` status, not the removed `terminalConnecting`
  // slice. Wire the region harness so `setTerminalConnecting` folds the region
  // (`session.connect`). Backend-reattach is unconditional (#2560), so these agent
  // tabs are backend-driven: `reconnectTerminal` fires (retry counter bumped) but
  // defers timing to the backend loop and arms no client connecting deadline.
  installSessionLifecycleHarness();

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
  });

  /** Run the real auto-retry restart loop over this agent's tabs. */
  function simulateRetryRestartLoop() {
    restartAgentRetryTabs(getAllTerminalTabs(), useAppStore.getState());
  }

  it("restarts a tab in auto-retry delay when agent reconnects", () => {
    const store = layoutState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const tab = getAllTerminalTabs()[0];
    // Simulate: user clicked Reconnect, now in auto-retry loop.
    store.setTerminalAutoRetrying(tab.id, 2);

    simulateRetryRestartLoop();

    const state = layoutState();
    // reconnectTerminal should have cleared the retry state and fired (retry counter
    // bumped). Agent tabs are backend-driven (#2560): no client connecting deadline
    // is armed — the backend loop owns the timing.
    expect(state.terminalAutoRetryCount[tab.id]).toBeUndefined();
    expect(state.terminalRetryCounters[tab.id]).toBe(1);
    expect(state.terminalConnectDeadline[tab.id]).toBeUndefined();
  });

  it("restarts a tab in 'Connection failed' state when agent reconnects", () => {
    const store = layoutState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const tab = getAllTerminalTabs()[0];
    // Simulate: showing "Connection failed" between retries.
    store.setTerminalSpawnError(tab.id, "Connection refused");

    simulateRetryRestartLoop();

    const state = layoutState();
    // reconnectTerminal should have cleared the error and fired (retry counter
    // bumped). Agent tabs are backend-driven (#2560): no client connecting deadline
    // is armed — the backend loop owns the timing.
    expect(state.terminalSpawnErrors[tab.id]).toBeUndefined();
    expect(state.terminalRetryCounters[tab.id]).toBe(1);
    expect(state.terminalConnectDeadline[tab.id]).toBeUndefined();
  });

  it("does not restart a tab that is actively connecting (createTerminal in-flight)", () => {
    const store = layoutState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const tab = getAllTerminalTabs()[0];
    // Simulate: createTerminal is in-flight (region folded to connecting).
    store.setTerminalAutoRetrying(tab.id, 1);
    store.setTerminalConnecting(tab.id, true);

    simulateRetryRestartLoop();

    const state = layoutState();
    // Must NOT call reconnectTerminal — don't interrupt an in-flight attempt.
    expect(state.terminalAutoRetryCount[tab.id]).toBe(1);
    expect(currentSessionView()[tab.id]?.status).toBe("connecting");
  });

  it("does not restart a tab that is waiting for agent (already handled)", () => {
    const store = layoutState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const tab = getAllTerminalTabs()[0];
    // Simulate: tab is parked via setTerminalWaitingForAgent, but autoRetryCount
    // was not cleared (setTerminalWaitingForAgent only clears terminalConnecting).
    store.setTerminalAutoRetrying(tab.id, 1);
    store.setTerminalWaitingForAgent(tab.id, "agent-1");

    simulateRetryRestartLoop();

    const state = layoutState();
    // Must NOT double-wake — waiting path handles this tab.
    expect(state.terminalWaitingForAgent[tab.id]).toBe("agent-1");
  });

  it("does not affect a tab with no connection-overlay state", () => {
    const store = layoutState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const tab = getAllTerminalTabs()[0];
    // Tab is connected normally — no overlay state set.

    simulateRetryRestartLoop();

    const state = layoutState();
    // No reconnect was kicked off, so no connect deadline was armed.
    expect(state.terminalConnectDeadline[tab.id]).toBeUndefined();
    expect(state.terminalAutoRetryCount[tab.id]).toBeUndefined();
  });
});
