/**
 * Regression tests for agent-state-change tab discovery.
 *
 * REGRESSION: Before the fix, the agent-state-change handlers in TerminalView
 * found affected tabs by cross-referencing agentSessions[agentId]. However,
 * agentSessions is only populated once on the initial "connected" event, when
 * no sessions exist yet. Any tabs opened after that refresh were invisible to
 * the handler, so no reconnect/disconnect overlays ever appeared — the user saw
 * a blank, empty tab with no feedback.
 *
 * The fix replaces the agentSessions lookup with a direct filter on
 * tab.config.config.agentId, which is always set for remote-session tabs.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { getAllLeaves } from "@/utils/panelTree";
import { useAppStore } from "@/store/appStore";
import { currentAgentsView } from "@/store/agentsBridge";
import { setupAgentsRegion } from "@/test/agentsRegionTestHarness";
import {
  currentSessionView,
  ensureSessionSubscribed,
  setSessionBackendReattachEnabled,
} from "@/store/sessionBridge";
import {
  connected,
  installSessionLifecycleHarness,
  reconnecting,
} from "@/test/sessionLifecycleRegionTestHarness";
import { applyAgentReconnecting } from "./agentStateHandlers";

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
  const store = useAppStore.getState();
  return [
    ...getAllLeaves(store.rootPanel).flatMap((l) => l.tabs),
    ...store.tabGroups.flatMap((g) => getAllLeaves(g.rootPanel).flatMap((l) => l.tabs)),
  ];
}

/** Helper: filter tabs that belong to a given agent (same filter as TerminalView). */
function findAgentTerminalTabs(agentId: string) {
  return getAllTerminalTabs().filter((tab) => {
    if (tab.contentType !== "terminal") return false;
    const cfg = tab.config.config as { agentId?: string };
    return cfg.agentId === agentId;
  });
}

setupAgentsRegion();

describe("agent-state-change tab discovery — regression for empty agentSessions", () => {
  // Reconnecting state moved off `appStore` into the projected `session-lifecycle`
  // region (#2205 PR-B / #2555): the real handler folds a live-session tab to
  // `reconnecting` via `applyAgentReconnecting` and gates the `connected`
  // transition on the region status. Wire the region harness so the fold lands,
  // and pin `sessionBackendReattach` OFF so these remote-session tabs take the
  // develop-parity (non-resilient) path — `setTerminalExited` then never re-folds
  // the region back to reconnecting via `session.reconnect`.
  installSessionLifecycleHarness();

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
    setSessionBackendReattachEnabled(false);
    vi.useFakeTimers();
  });

  afterEach(() => {
    setSessionBackendReattachEnabled(null);
    vi.useRealTimers();
  });

  it("finds a remote-session tab by config.agentId even when agentSessions is empty", () => {
    // Simulate the bug condition: sessions were opened after the initial
    // refreshAgentSessions call, so agentSessions is empty.
    const store = useAppStore.getState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });

    // agentSessions["agent-1"] is empty — this was the bug condition.
    expect(currentAgentsView().agentSessions["agent-1"] ?? []).toHaveLength(0);

    // The fixed handler finds tabs via config.agentId, not agentSessions.
    const found = findAgentTerminalTabs("agent-1");
    expect(found).toHaveLength(1);
    expect(found[0].connectionType).toBe("remote-session");
  });

  it("does not include tabs from a different agent", () => {
    const store = useAppStore.getState();
    store.addTab("Shell A", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    store.addTab("Shell B", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-2", sessionType: "shell" },
    });

    expect(findAgentTerminalTabs("agent-1")).toHaveLength(1);
    expect(findAgentTerminalTabs("agent-2")).toHaveLength(1);
  });

  it("does not include non-terminal tabs (settings, log-viewer, etc.)", () => {
    const store = useAppStore.getState();
    // Add a terminal remote-session tab.
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    // Directly inject a non-terminal tab that coincidentally has agentId in meta.
    // (In practice non-terminal tabs don't have agentId, but guard against it anyway.)
    const allPanels = useAppStore.getState().getAllPanels();
    const panel = allPanels[0];
    useAppStore.setState((s) => ({
      rootPanel: injectTabIntoPanel(s.rootPanel, panel.id, {
        id: "non-terminal-tab",
        title: "Settings",
        contentType: "settings",
        connectionType: "local",
        sessionId: null,
        panelId: panel.id,
        isActive: false,
        config: { type: "settings", config: { agentId: "agent-1" } },
      }),
    }));

    // Only the terminal tab should be found.
    const found = findAgentTerminalTabs("agent-1");
    expect(found).toHaveLength(1);
    expect(found[0].contentType).toBe("terminal");
  });

  // ── State machine: reconnecting ────────────────────────────────────────────

  it("'reconnecting' marks active-session tabs as reconnecting", () => {
    const store = useAppStore.getState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const tab = getAllTerminalTabs()[0];
    // Simulate that the session was established.
    useAppStore.getState().setTabSessionId(tab.id, "session-123");

    // The real "reconnecting" handler folds live-session tabs to reconnecting.
    applyAgentReconnecting("agent-1", findAgentTerminalTabs("agent-1"), undefined);

    expect(currentSessionView()[tab.id]?.status).toBe("reconnecting");
  });

  it("'reconnecting' skips tabs without an established session", () => {
    const store = useAppStore.getState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const tab = getAllTerminalTabs()[0];
    // sessionId is still null (session not established yet).
    expect(tab.sessionId).toBeNull();

    applyAgentReconnecting("agent-1", findAgentTerminalTabs("agent-1"), undefined);

    // A spawning tab is parked waiting instead of being folded to reconnecting.
    expect(currentSessionView()[tab.id]?.status).not.toBe("reconnecting");
    expect(useAppStore.getState().terminalWaitingForAgent[tab.id]).toBe("agent-1");
  });

  // ── State machine: connected (after auto-reconnect) ────────────────────────

  it("'connected' after auto-reconnect transitions reconnecting tabs to exited", () => {
    const store = useAppStore.getState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const tab = getAllTerminalTabs()[0];
    useAppStore.getState().setTabSessionId(tab.id, "session-123");
    // Simulate prior "reconnecting" state (folded into the region).
    applyAgentReconnecting("agent-1", findAgentTerminalTabs("agent-1"), undefined);

    // Simulate fixed "connected" handler — transitions reconnecting → exited. The
    // handler now gates on the region status (the sole reconnecting source).
    for (const t of findAgentTerminalTabs("agent-1")) {
      if (currentSessionView()[t.id]?.status === "reconnecting") {
        useAppStore.getState().setTerminalExited(t.id);
      }
    }

    // Overlay should now show "Session disconnected" (exited flag set).
    expect(useAppStore.getState().terminalExitedTabs[tab.id]).toBe(true);
  });

  it("'connected' on initial connect does not mark tabs as exited", () => {
    const store = useAppStore.getState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const tab = getAllTerminalTabs()[0];
    useAppStore.getState().setTabSessionId(tab.id, "session-123");
    // Tab is NOT in reconnecting state (first connect, no prior disconnect).

    // Simulate fixed "connected" handler — should be a no-op for this tab.
    for (const t of findAgentTerminalTabs("agent-1")) {
      if (currentSessionView()[t.id]?.status === "reconnecting") {
        useAppStore.getState().setTerminalExited(t.id);
      }
    }

    const state = useAppStore.getState();
    expect(state.terminalExitedTabs[tab.id]).toBeUndefined();
    expect(currentSessionView()[tab.id]?.status).not.toBe("reconnecting");
  });

  // ── State machine: disconnected ─────────────────────────────────────────────

  it("'disconnected' marks active-session tabs as exited", () => {
    const store = useAppStore.getState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const tab = getAllTerminalTabs()[0];
    useAppStore.getState().setTabSessionId(tab.id, "session-123");

    // Simulate fixed "disconnected" handler:
    for (const t of findAgentTerminalTabs("agent-1")) {
      if (!t.sessionId) continue;
      useAppStore.getState().setTerminalExited(t.id);
    }

    expect(useAppStore.getState().terminalExitedTabs[tab.id]).toBe(true);
  });

  it("'disconnected' with error surfaces the error in the overlay", () => {
    const store = useAppStore.getState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const tab = getAllTerminalTabs()[0];
    useAppStore.getState().setTabSessionId(tab.id, "session-123");

    const errorMsg = "Failed to reconnect after 10 attempts";

    // Simulate fixed "disconnected" handler with error:
    for (const t of findAgentTerminalTabs("agent-1")) {
      if (!t.sessionId) continue;
      useAppStore.getState().setTerminalDisconnectWithError(t.id, errorMsg);
    }

    const state = useAppStore.getState();
    expect(state.terminalExitedTabs[tab.id]).toBe(true);
    expect(state.terminalDisconnectErrors[tab.id]).toBe(errorMsg);
  });

  it("'disconnected' while reconnecting clears the reconnecting spinner", () => {
    const store = useAppStore.getState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const tab = getAllTerminalTabs()[0];
    useAppStore.getState().setTabSessionId(tab.id, "session-123");
    applyAgentReconnecting("agent-1", findAgentTerminalTabs("agent-1"), undefined);

    // Simulate "disconnected" with error (all retries exhausted):
    for (const t of findAgentTerminalTabs("agent-1")) {
      if (!t.sessionId) continue;
      useAppStore
        .getState()
        .setTerminalDisconnectWithError(t.id, "Failed to reconnect after 10 attempts");
    }

    const state = useAppStore.getState();
    // The tab lands exited so the "Reconnect failed" error overlay is shown.
    expect(state.terminalExitedTabs[tab.id]).toBe(true);
    expect(state.terminalDisconnectErrors[tab.id]).toBe("Failed to reconnect after 10 attempts");
  });
});

// ── Session recovery: 'connected' after power-cycle ─────────────────────────

/**
 * REGRESSION: Before this fix, the 'connected' handler always called
 * setTerminalExited() for every reconnecting tab, even when the agent
 * successfully recovered the session with the same session ID.
 * The user reported that "the reconnect never reconnected after the new power
 * up" — the frontend was forcing the disconnect overlay on every agent restart.
 *
 * The fix checks listAgentSessions() and only marks sessions as exited when
 * they are NOT in the recovered list.
 */
describe("agent-state-change 'connected': session recovery after power cycle", () => {
  // Reconnecting state is region-sourced now (#2205 PR-B): the handler gates the
  // resume-vs-exit decision on the projected `session-lifecycle` status, so seed
  // the region via the harness transport rather than the removed
  // `terminalReconnectingTabs` slice. `sessionBackendReattach` OFF ⇒ the exit
  // path's `setTerminalExited` folds `session.dropped` (terminal), never
  // re-folding the region back to reconnecting.
  const harness = installSessionLifecycleHarness();

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
    setSessionBackendReattachEnabled(false);
  });

  afterEach(() => {
    setSessionBackendReattachEnabled(null);
  });

  /** Seed a tab into the region as reconnecting (the prior-disconnect state). */
  async function seedReconnecting(tabId: string) {
    await ensureSessionSubscribed();
    harness.transport.setSession(
      tabId,
      reconnecting({ phase: "waiting", attempt: 0, delayMs: 1000 })
    );
  }

  /**
   * Simulate the fixed 'connected' handler with a given recovered-sessions list.
   * The decision is gated on the region status (the sole reconnecting source); a
   * survived session folds the region `reconnecting → connected`, a lost one marks
   * the tab exited (the "Session disconnected" overlay).
   */
  function simulateConnectedHandler(agentId: string, recoveredSessionIds: string[]) {
    const store = useAppStore.getState();
    const allTabs = [
      ...getAllLeaves(store.rootPanel).flatMap((l) => l.tabs),
      ...store.tabGroups.flatMap((g) => getAllLeaves(g.rootPanel).flatMap((l) => l.tabs)),
    ];
    const agentTerminalTabs = allTabs.filter((tab) => {
      if (tab.contentType !== "terminal") return false;
      const cfg = tab.config.config as { agentId?: string };
      return cfg.agentId === agentId;
    });

    const recovered = new Set(recoveredSessionIds);
    for (const tab of agentTerminalTabs) {
      if (currentSessionView()[tab.id]?.status !== "reconnecting") continue;
      if (tab.sessionId && recovered.has(tab.sessionId)) {
        // Session survived — the region resolves reconnecting → connected.
        harness.transport.setSession(tab.id, connected());
      } else {
        useAppStore.getState().setTerminalExited(tab.id);
      }
    }
  }

  it("resumes a tab whose session was recovered by the agent", async () => {
    const store = useAppStore.getState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const tab = getAllTerminalTabs()[0];
    useAppStore.getState().setTabSessionId(tab.id, "session-123");
    await seedReconnecting(tab.id);

    simulateConnectedHandler("agent-1", ["session-123"]);

    const state = useAppStore.getState();
    // Reconnecting resolved — session resumes automatically (region → connected).
    expect(currentSessionView()[tab.id]?.status).not.toBe("reconnecting");
    // Must NOT be marked as exited.
    expect(state.terminalExitedTabs[tab.id]).toBeUndefined();
  });

  it("marks a tab as exited when its session was NOT recovered", async () => {
    const store = useAppStore.getState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const tab = getAllTerminalTabs()[0];
    useAppStore.getState().setTabSessionId(tab.id, "session-123");
    await seedReconnecting(tab.id);

    simulateConnectedHandler("agent-1", []); // no sessions recovered

    expect(useAppStore.getState().terminalExitedTabs[tab.id]).toBe(true);
  });

  it("handles mixed recovery: resumes surviving sessions, exits dead ones", async () => {
    const store = useAppStore.getState();
    store.addTab("Shell A", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    store.addTab("Shell B", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const [tabA, tabB] = getAllTerminalTabs();
    useAppStore.getState().setTabSessionId(tabA.id, "session-aaa");
    useAppStore.getState().setTabSessionId(tabB.id, "session-bbb");
    await seedReconnecting(tabA.id);
    await seedReconnecting(tabB.id);

    // Only session-aaa recovered.
    simulateConnectedHandler("agent-1", ["session-aaa"]);

    const state = useAppStore.getState();
    expect(currentSessionView()[tabA.id]?.status).not.toBe("reconnecting");
    expect(state.terminalExitedTabs[tabA.id]).toBeUndefined(); // resumed
    expect(state.terminalExitedTabs[tabB.id]).toBe(true); // not recovered
  });

  it("marks all reconnecting tabs as exited when listAgentSessions fails (safe fallback)", async () => {
    const store = useAppStore.getState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const tab = getAllTerminalTabs()[0];
    useAppStore.getState().setTabSessionId(tab.id, "session-123");
    await seedReconnecting(tab.id);

    // Simulate catch branch: recoveredSessionIds is empty Set.
    simulateConnectedHandler("agent-1", []);

    expect(useAppStore.getState().terminalExitedTabs[tab.id]).toBe(true);
  });

  it("does not affect tabs that are not in reconnecting state", async () => {
    const store = useAppStore.getState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const tab = getAllTerminalTabs()[0];
    useAppStore.getState().setTabSessionId(tab.id, "session-123");
    // Tab is NOT in reconnecting state (newly opened tab, not affected by the outage).
    await ensureSessionSubscribed();

    simulateConnectedHandler("agent-1", []);

    const state = useAppStore.getState();
    expect(state.terminalExitedTabs[tab.id]).toBeUndefined();
    expect(currentSessionView()[tab.id]?.status).not.toBe("reconnecting");
  });
});

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
  // (`session.connect`), and pin `sessionBackendReattach` OFF so `reconnectTerminal`
  // arms the fixed "connecting" wall-clock deadline (the surviving connect signal)
  // instead of deferring to the backend loop.
  installSessionLifecycleHarness();

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
    setSessionBackendReattachEnabled(false);
  });

  afterEach(() => {
    setSessionBackendReattachEnabled(null);
  });

  /** Simulate the new loop added for auto-retry tab restart. */
  function simulateRetryRestartLoop(agentId: string) {
    const store = useAppStore.getState();
    const allTabs = [
      ...getAllLeaves(store.rootPanel).flatMap((l) => l.tabs),
      ...store.tabGroups.flatMap((g) => getAllLeaves(g.rootPanel).flatMap((l) => l.tabs)),
    ];
    const agentTerminalTabs = allTabs.filter((tab) => {
      if (tab.contentType !== "terminal") return false;
      const cfg = tab.config.config as { agentId?: string };
      return cfg.agentId === agentId;
    });

    for (const tab of agentTerminalTabs) {
      const hasSpawnError = !!store.terminalSpawnErrors[tab.id];
      const isAutoRetrying = (store.terminalAutoRetryCount[tab.id] ?? 0) > 0;
      const wasWaiting = !!store.terminalWaitingForAgent[tab.id];
      const isConnecting = currentSessionView()[tab.id]?.status === "connecting";
      if ((hasSpawnError || isAutoRetrying) && !wasWaiting && !isConnecting) {
        store.reconnectTerminal(tab.id);
      }
    }
  }

  it("restarts a tab in auto-retry delay when agent reconnects", () => {
    const store = useAppStore.getState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const tab = getAllTerminalTabs()[0];
    // Simulate: user clicked Reconnect, now in auto-retry loop.
    store.setTerminalAutoRetrying(tab.id, 2);

    simulateRetryRestartLoop("agent-1");

    const state = useAppStore.getState();
    // reconnectTerminal should have cleared the retry state and armed the
    // "connecting" deadline (the surviving connect signal after #2205 PR-B).
    expect(state.terminalAutoRetryCount[tab.id]).toBeUndefined();
    expect(state.terminalConnectDeadline[tab.id]?.kind).toBe("connecting");
  });

  it("restarts a tab in 'Connection failed' state when agent reconnects", () => {
    const store = useAppStore.getState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const tab = getAllTerminalTabs()[0];
    // Simulate: showing "Connection failed" between retries.
    store.setTerminalSpawnError(tab.id, "Connection refused");

    simulateRetryRestartLoop("agent-1");

    const state = useAppStore.getState();
    // reconnectTerminal should have cleared the error and armed the connect deadline.
    expect(state.terminalSpawnErrors[tab.id]).toBeUndefined();
    expect(state.terminalConnectDeadline[tab.id]?.kind).toBe("connecting");
  });

  it("does not restart a tab that is actively connecting (createTerminal in-flight)", () => {
    const store = useAppStore.getState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const tab = getAllTerminalTabs()[0];
    // Simulate: createTerminal is in-flight (region folded to connecting).
    store.setTerminalAutoRetrying(tab.id, 1);
    store.setTerminalConnecting(tab.id, true);

    simulateRetryRestartLoop("agent-1");

    const state = useAppStore.getState();
    // Must NOT call reconnectTerminal — don't interrupt an in-flight attempt.
    expect(state.terminalAutoRetryCount[tab.id]).toBe(1);
    expect(currentSessionView()[tab.id]?.status).toBe("connecting");
  });

  it("does not restart a tab that is waiting for agent (already handled)", () => {
    const store = useAppStore.getState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const tab = getAllTerminalTabs()[0];
    // Simulate: tab is parked via setTerminalWaitingForAgent, but autoRetryCount
    // was not cleared (setTerminalWaitingForAgent only clears terminalConnecting).
    store.setTerminalAutoRetrying(tab.id, 1);
    store.setTerminalWaitingForAgent(tab.id, "agent-1");

    simulateRetryRestartLoop("agent-1");

    const state = useAppStore.getState();
    // Must NOT double-wake — waiting path handles this tab.
    expect(state.terminalWaitingForAgent[tab.id]).toBe("agent-1");
  });

  it("does not affect a tab with no connection-overlay state", () => {
    const store = useAppStore.getState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const tab = getAllTerminalTabs()[0];
    // Tab is connected normally — no overlay state set.

    simulateRetryRestartLoop("agent-1");

    const state = useAppStore.getState();
    // No reconnect was kicked off, so no connect deadline was armed.
    expect(state.terminalConnectDeadline[tab.id]).toBeUndefined();
    expect(state.terminalAutoRetryCount[tab.id]).toBeUndefined();
  });
});

// ── Utility ─────────────────────────────────────────────────────────────────

/** Inject a tab into a named leaf panel (used only in tests). */
function injectTabIntoPanel(
  node: ReturnType<typeof useAppStore.getState>["rootPanel"],
  panelId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tab: any
): ReturnType<typeof useAppStore.getState>["rootPanel"] {
  if (node.type === "leaf") {
    if (node.id === panelId) {
      return { ...node, tabs: [...node.tabs, tab] };
    }
    return node;
  }
  return {
    ...node,
    children: node.children.map((child) => injectTabIntoPanel(child, panelId, tab)),
  };
}
