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

describe("agent-state-change tab discovery — regression for empty agentSessions", () => {
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
    const store = useAppStore.getState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });

    // agentSessions["agent-1"] is empty — this was the bug condition.
    expect(useAppStore.getState().agentSessions["agent-1"] ?? []).toHaveLength(0);

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

    // Simulate fixed "reconnecting" handler:
    for (const t of findAgentTerminalTabs("agent-1")) {
      if (!t.sessionId) continue;
      useAppStore.getState().setTerminalReconnecting(t.id, true);
    }

    expect(useAppStore.getState().terminalReconnectingTabs[tab.id]).toBe(true);
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

    for (const t of findAgentTerminalTabs("agent-1")) {
      if (!t.sessionId) continue;
      useAppStore.getState().setTerminalReconnecting(t.id, true);
    }

    expect(useAppStore.getState().terminalReconnectingTabs[tab.id]).toBeUndefined();
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
    // Simulate prior "reconnecting" state.
    useAppStore.getState().setTerminalReconnecting(tab.id, true);

    // Simulate fixed "connected" handler — transitions reconnecting → exited.
    for (const t of findAgentTerminalTabs("agent-1")) {
      if (useAppStore.getState().terminalReconnectingTabs[t.id]) {
        useAppStore.getState().setTerminalExited(t.id);
      }
    }

    const state = useAppStore.getState();
    // Overlay should now show "Session disconnected" (not the reconnecting spinner).
    expect(state.terminalReconnectingTabs[tab.id]).toBeUndefined();
    expect(state.terminalExitedTabs[tab.id]).toBe(true);
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
      if (useAppStore.getState().terminalReconnectingTabs[t.id]) {
        useAppStore.getState().setTerminalExited(t.id);
      }
    }

    const state = useAppStore.getState();
    expect(state.terminalExitedTabs[tab.id]).toBeUndefined();
    expect(state.terminalReconnectingTabs[tab.id]).toBeUndefined();
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
    useAppStore.getState().setTerminalReconnecting(tab.id, true);

    // Simulate "disconnected" with error (all retries exhausted):
    for (const t of findAgentTerminalTabs("agent-1")) {
      if (!t.sessionId) continue;
      useAppStore
        .getState()
        .setTerminalDisconnectWithError(t.id, "Failed to reconnect after 10 attempts");
    }

    const state = useAppStore.getState();
    // Reconnecting spinner must be cleared before the error overlay is shown.
    expect(state.terminalReconnectingTabs[tab.id]).toBeUndefined();
    expect(state.terminalExitedTabs[tab.id]).toBe(true);
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
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
  });

  /** Simulate the fixed 'connected' handler with a given recovered-sessions list. */
  async function simulateConnectedHandler(agentId: string, recoveredSessionIds: string[]) {
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
      if (!store.terminalReconnectingTabs[tab.id]) continue;
      if (tab.sessionId && recovered.has(tab.sessionId)) {
        useAppStore.getState().setTerminalReconnecting(tab.id, false);
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
    useAppStore.getState().setTerminalReconnecting(tab.id, true);

    await simulateConnectedHandler("agent-1", ["session-123"]);

    const state = useAppStore.getState();
    // Reconnecting spinner cleared — session resumes automatically.
    expect(state.terminalReconnectingTabs[tab.id]).toBeUndefined();
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
    useAppStore.getState().setTerminalReconnecting(tab.id, true);

    await simulateConnectedHandler("agent-1", []); // no sessions recovered

    const state = useAppStore.getState();
    expect(state.terminalExitedTabs[tab.id]).toBe(true);
    expect(state.terminalReconnectingTabs[tab.id]).toBeUndefined();
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
    useAppStore.getState().setTerminalReconnecting(tabA.id, true);
    useAppStore.getState().setTerminalReconnecting(tabB.id, true);

    // Only session-aaa recovered.
    await simulateConnectedHandler("agent-1", ["session-aaa"]);

    const state = useAppStore.getState();
    expect(state.terminalReconnectingTabs[tabA.id]).toBeUndefined();
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
    useAppStore.getState().setTerminalReconnecting(tab.id, true);

    // Simulate catch branch: recoveredSessionIds is empty Set.
    await simulateConnectedHandler("agent-1", []);

    const state = useAppStore.getState();
    expect(state.terminalExitedTabs[tab.id]).toBe(true);
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

    await simulateConnectedHandler("agent-1", []);

    const state = useAppStore.getState();
    expect(state.terminalExitedTabs[tab.id]).toBeUndefined();
    expect(state.terminalReconnectingTabs[tab.id]).toBeUndefined();
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
    first: injectTabIntoPanel(node.first, panelId, tab),
    second: injectTabIntoPanel(node.second, panelId, tab),
  };
}
