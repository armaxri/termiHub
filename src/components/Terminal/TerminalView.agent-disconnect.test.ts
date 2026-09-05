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
import type { PanelNode } from "@/types/terminal";
import { useAppStore } from "@/store/appStore";
import { layoutState, seedLayoutState } from "@/test/layoutState";
import { currentAgentsView } from "@/store/agentsBridge";
import { setupAgentsRegion } from "@/test/agentsRegionTestHarness";
import {
  currentSessionView,
  ensureSessionSubscribed,
  regionExited,
} from "@/store/sessionBridge";
import {
  connected,
  failed,
  installSessionLifecycleHarness,
  reconnecting,
  sessionLost,
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
  const store = layoutState();
  return store.tabGroups.flatMap((g) => getAllLeaves(g.rootPanel).flatMap((l) => l.tabs));
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
  // region (#2205 PR-B / #2555). Post-#2556 the transient-break reconnecting fold
  // is **backend-owned** (`agent_io_task`), so `applyAgentReconnecting` no longer
  // mirrors it on the client; a test seeds the reconnecting region via the harness
  // to represent that server fold, then the `connected` transition gates on the
  // region status. These tests drive the handlers directly and call
  // `setTerminalExited` without a `dropped` reason, so the exit path triggers no
  // region reconnect fold.
  const harness = installSessionLifecycleHarness();

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("finds a remote-session tab by config.agentId even when agentSessions is empty", () => {
    // Simulate the bug condition: sessions were opened after the initial
    // refreshAgentSessions call, so agentSessions is empty.
    const store = layoutState();
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
    const store = layoutState();
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
    const store = layoutState();
    // Add a terminal remote-session tab.
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    // Directly inject a non-terminal tab that coincidentally has agentId in meta.
    // (In practice non-terminal tabs don't have agentId, but guard against it anyway.)
    const allPanels = layoutState().getAllPanels();
    const panel = allPanels[0];
    seedLayoutState({
      rootPanel: injectTabIntoPanel(layoutState().rootPanel, panel.id, {
        id: "non-terminal-tab",
        title: "Settings",
        contentType: "settings",
        connectionType: "local",
        sessionId: null,
        panelId: panel.id,
        isActive: false,
        config: { type: "settings", config: { agentId: "agent-1" } },
      }),
    });

    // Only the terminal tab should be found.
    const found = findAgentTerminalTabs("agent-1");
    expect(found).toHaveLength(1);
    expect(found[0].contentType).toBe("terminal");
  });

  // ── State machine: reconnecting ────────────────────────────────────────────

  it("'reconnecting' no longer folds a live-session tab on the client — the backend owns it (#2556)", () => {
    const store = layoutState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const tab = getAllTerminalTabs()[0];
    // Simulate that the session was established.
    useAppStore.getState().setTabSessionId(tab.id, "session-123");

    // The transient-break reconnecting fold moved fully server-side (#2556): the
    // client handler leaves a live-session tab's region entry untouched (the
    // backend `agent_io_task` folds it), and does not park it waiting.
    applyAgentReconnecting("agent-1", findAgentTerminalTabs("agent-1"), undefined);

    expect(currentSessionView()[tab.id]?.status).not.toBe("reconnecting");
    expect(useAppStore.getState().terminalWaitingForAgent[tab.id]).toBeUndefined();
  });

  it("'reconnecting' skips tabs without an established session", () => {
    const store = layoutState();
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

  it("'connected' after auto-reconnect transitions reconnecting tabs to exited", async () => {
    const store = layoutState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const tab = getAllTerminalTabs()[0];
    useAppStore.getState().setTabSessionId(tab.id, "session-123");
    // Prior "reconnecting" state now comes from the backend fold (#2556); seed the
    // region to represent it rather than the removed client mirror.
    await ensureSessionSubscribed();
    harness.transport.setSession(
      tab.id,
      reconnecting({ phase: "waiting", attempt: 0, delayMs: 1000 })
    );

    // Simulate the "connected" handler — a gone session (not recovered) settles the
    // tab session-lost. The handler gates on the region status (the sole
    // reconnecting source); the backend folds the gone session to `sessionLost`,
    // which `settleSessionLost` reflects (clearing the in-flight flags).
    for (const t of findAgentTerminalTabs("agent-1")) {
      if (currentSessionView()[t.id]?.status === "reconnecting") {
        harness.transport.setSession(t.id, sessionLost());
        useAppStore.getState().settleSessionLost(t.id);
      }
    }

    // The overlay now mounts from the region's terminal (session-lost) status.
    expect(regionExited(currentSessionView()[tab.id])).toBe(true);
  });

  it("'connected' on initial connect does not mark tabs as exited", () => {
    const store = layoutState();
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
        harness.transport.setSession(t.id, sessionLost());
        useAppStore.getState().settleSessionLost(t.id);
      }
    }

    // Not reconnecting, so the loop is a no-op and the region never marks it exited.
    expect(regionExited(currentSessionView()[tab.id])).toBe(false);
    expect(currentSessionView()[tab.id]?.status).not.toBe("reconnecting");
  });

  // ── State machine: disconnected ─────────────────────────────────────────────

  it("'disconnected' (no error) arms the backend reconnect for active-session agent tabs", () => {
    const store = layoutState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const tab = getAllTerminalTabs()[0];
    useAppStore.getState().setTabSessionId(tab.id, "session-123");

    // Simulate the "disconnected" handler (no error): a dropped exit. An agent tab
    // is always resilient, so the drop folds `session.reconnect` (region →
    // reconnecting), arming the backend redrive rather than landing exited.
    for (const t of findAgentTerminalTabs("agent-1")) {
      if (!t.sessionId) continue;
      useAppStore.getState().setTerminalExited(t.id, { code: null, reason: "dropped" });
    }

    expect(currentSessionView()[tab.id]?.status).toBe("reconnecting");
  });

  it("'disconnected' with error surfaces the error from the region (#2612/#2564)", async () => {
    const store = layoutState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const tab = getAllTerminalTabs()[0];
    useAppStore.getState().setTabSessionId(tab.id, "session-123");

    const errorMsg = "Failed to reconnect after 10 attempts";

    // Fully-failed reconnect: the backend `agent_io_task` folds the region entry
    // `reconnecting → failed` at the source with the reconnect error (#2612/#2564);
    // seed the region to represent that server fold, then the handler reflects only
    // the local presentation view-state via `settleBackendReconnectGaveUp` — never
    // re-driving the region.
    await ensureSessionSubscribed();
    harness.transport.setSession(tab.id, failed(errorMsg));
    for (const t of findAgentTerminalTabs("agent-1")) {
      if (!t.sessionId) continue;
      useAppStore.getState().settleBackendReconnectGaveUp(t.id, errorMsg);
    }

    // The region carries the backend-folded `failed` authority (#2625): it both
    // mounts the overlay (`regionExited`) and surfaces the "Reconnect failed" error.
    const life = currentSessionView()[tab.id];
    expect(life?.status).toBe("failed");
    expect(life?.error).toBe(errorMsg);
    expect(regionExited(life)).toBe(true);
  });

  it("'disconnected' while reconnecting folds the region off reconnecting to failed", async () => {
    const store = layoutState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const tab = getAllTerminalTabs()[0];
    useAppStore.getState().setTabSessionId(tab.id, "session-123");
    // Prior transient-break "reconnecting" state comes from the backend fold (#2556);
    // seed the region to represent it (the client no longer mirrors it).
    await ensureSessionSubscribed();
    harness.transport.setSession(
      tab.id,
      reconnecting({ phase: "waiting", attempt: 0, delayMs: 1000 })
    );
    const errorMsg = "Failed to reconnect after 10 attempts";

    // Fully failed (all retries exhausted): the backend folds `reconnecting → failed`
    // at the source; the handler reflects only the local view-state.
    harness.transport.setSession(tab.id, failed(errorMsg));
    for (const t of findAgentTerminalTabs("agent-1")) {
      if (!t.sessionId) continue;
      useAppStore.getState().settleBackendReconnectGaveUp(t.id, errorMsg);
    }

    // The region left `reconnecting` (no stuck spinner) and lands `failed` + error,
    // so `regionExited` mounts the "Reconnect failed" overlay (region-only, #2625).
    const life = currentSessionView()[tab.id];
    expect(life?.status).toBe("failed");
    expect(life?.error).toBe(errorMsg);
    expect(regionExited(life)).toBe(true);
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
  // resume-vs-lost decision on the projected `session-lifecycle` status, so seed
  // the region via the harness transport rather than the removed
  // `terminalReconnectingTabs` slice. The gone-case resolve is folded `sessionLost`
  // at the backend source (#2564); the handler reflects only the local view-state
  // via `settleSessionLost`, never re-driving the region.
  const harness = installSessionLifecycleHarness();

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
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
   * survived session folds the region `reconnecting → connected`, a gone one is
   * folded `reconnecting → sessionLost` at the **backend source** (#2564) — mirror
   * that here — and the handler reflects only the local presentation view-state via
   * `settleSessionLost` (never re-driving the region). The gate accepts either the
   * mid-break `reconnecting` status or the already-folded `sessionLost`, matching
   * the real handler's race-tolerance.
   */
  function simulateConnectedHandler(agentId: string, recoveredSessionIds: string[]) {
    const store = layoutState();
    const allTabs = store.tabGroups.flatMap((g) =>
      getAllLeaves(g.rootPanel).flatMap((l) => l.tabs)
    );
    const agentTerminalTabs = allTabs.filter((tab) => {
      if (tab.contentType !== "terminal") return false;
      const cfg = tab.config.config as { agentId?: string };
      return cfg.agentId === agentId;
    });

    const recovered = new Set(recoveredSessionIds);
    for (const tab of agentTerminalTabs) {
      const status = currentSessionView()[tab.id]?.status;
      if (status !== "reconnecting" && status !== "sessionLost") continue;
      if (tab.sessionId && recovered.has(tab.sessionId)) {
        // Session survived — the region resolves reconnecting → connected.
        harness.transport.setSession(tab.id, connected());
      } else {
        // Gone: the backend folds the region sessionLost (#2564); the handler only
        // reflects the local view-state so the overlay mounts.
        harness.transport.setSession(tab.id, sessionLost());
        useAppStore.getState().settleSessionLost(tab.id);
      }
    }
  }

  it("resumes a tab whose session was recovered by the agent", async () => {
    const store = layoutState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const tab = getAllTerminalTabs()[0];
    useAppStore.getState().setTabSessionId(tab.id, "session-123");
    await seedReconnecting(tab.id);

    simulateConnectedHandler("agent-1", ["session-123"]);

    // Reconnecting resolved — session resumes automatically (region → connected).
    expect(currentSessionView()[tab.id]?.status).not.toBe("reconnecting");
    // Must NOT be marked as exited (region-only, #2625).
    expect(regionExited(currentSessionView()[tab.id])).toBe(false);
  });

  it("marks a tab as exited when its session was NOT recovered", async () => {
    const store = layoutState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const tab = getAllTerminalTabs()[0];
    useAppStore.getState().setTabSessionId(tab.id, "session-123");
    await seedReconnecting(tab.id);

    simulateConnectedHandler("agent-1", []); // no sessions recovered

    // The region carries the backend-folded `sessionLost` authority (#2564): it
    // mounts the overlay (`regionExited`, #2625) and renders the "Session lost"
    // notice — never re-driven to reconnecting/dropped by the client.
    expect(currentSessionView()[tab.id]?.status).toBe("sessionLost");
    expect(regionExited(currentSessionView()[tab.id])).toBe(true);
  });

  it("handles mixed recovery: resumes surviving sessions, exits dead ones", async () => {
    const store = layoutState();
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

    expect(currentSessionView()[tabA.id]?.status).not.toBe("reconnecting");
    expect(regionExited(currentSessionView()[tabA.id])).toBe(false); // resumed
    expect(regionExited(currentSessionView()[tabB.id])).toBe(true); // not recovered
  });

  it("marks all reconnecting tabs as exited when listAgentSessions fails (safe fallback)", async () => {
    const store = layoutState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const tab = getAllTerminalTabs()[0];
    useAppStore.getState().setTabSessionId(tab.id, "session-123");
    await seedReconnecting(tab.id);

    // Simulate catch branch: recoveredSessionIds is empty Set.
    simulateConnectedHandler("agent-1", []);

    expect(regionExited(currentSessionView()[tab.id])).toBe(true);
  });

  it("does not affect tabs that are not in reconnecting state", async () => {
    const store = layoutState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const tab = getAllTerminalTabs()[0];
    useAppStore.getState().setTabSessionId(tab.id, "session-123");
    // Tab is NOT in reconnecting state (newly opened tab, not affected by the outage).
    await ensureSessionSubscribed();

    simulateConnectedHandler("agent-1", []);

    expect(regionExited(currentSessionView()[tab.id])).toBe(false);
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
  // (`session.connect`). Backend-reattach is unconditional (#2560), so these agent
  // tabs are backend-driven: `reconnectTerminal` fires (retry counter bumped) but
  // defers timing to the backend loop and arms no client connecting deadline.
  installSessionLifecycleHarness();

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
  });

  /** Simulate the new loop added for auto-retry tab restart. */
  function simulateRetryRestartLoop(agentId: string) {
    const store = layoutState();
    const allTabs = store.tabGroups.flatMap((g) =>
      getAllLeaves(g.rootPanel).flatMap((l) => l.tabs)
    );
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
    const store = layoutState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const tab = getAllTerminalTabs()[0];
    // Simulate: user clicked Reconnect, now in auto-retry loop.
    store.setTerminalAutoRetrying(tab.id, 2);

    simulateRetryRestartLoop("agent-1");

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

    simulateRetryRestartLoop("agent-1");

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

    simulateRetryRestartLoop("agent-1");

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

    simulateRetryRestartLoop("agent-1");

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

    simulateRetryRestartLoop("agent-1");

    const state = layoutState();
    // No reconnect was kicked off, so no connect deadline was armed.
    expect(state.terminalConnectDeadline[tab.id]).toBeUndefined();
    expect(state.terminalAutoRetryCount[tab.id]).toBeUndefined();
  });
});

// ── Utility ─────────────────────────────────────────────────────────────────

/** Inject a tab into a named leaf panel (used only in tests). */
function injectTabIntoPanel(
  node: PanelNode,
  panelId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tab: any
): PanelNode {
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
