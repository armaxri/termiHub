/**
 * Tests for the agent `reconnecting` state handler (G8, #1242).
 *
 * REGRESSION / GAP: When the agent link drops while a tab is still mid
 * `connection.create` (no `sessionId` yet), the old `reconnecting` branch in
 * TerminalView skipped the tab entirely (`if (!tab.sessionId) continue;`). Such
 * a tab landed ambiguously — it never showed the reconnecting/waiting feedback
 * and typically surfaced a raw spawn error instead.
 *
 * The fix routes sessionId-less agent tabs to the waiting/retry path
 * (`terminalWaitingForAgent`) on `reconnecting`, so every agent tab gets honest
 * feedback during a drop. Tabs that already have a session keep the existing
 * behaviour (reconnecting spinner overlay).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getAllLeaves } from "@/utils/panelTree";
import { useAppStore } from "@/store/appStore";
import {
  currentSessionView,
  setSessionIntentsEnabled,
  setSessionTransportForTest,
  stopSessionSubscription,
} from "@/store/sessionBridge";
import { FakeSessionTransport } from "@/test/sessionLifecycleRegionTestHarness";
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

/** Collect all terminal tabs from all panels in the current store state. */
function getAllTerminalTabs() {
  const store = useAppStore.getState();
  return [
    ...getAllLeaves(store.rootPanel).flatMap((l) => l.tabs),
    ...store.tabGroups.flatMap((g) => getAllLeaves(g.rootPanel).flatMap((l) => l.tabs)),
  ];
}

/** Same agent-tab filter used by the real handler. */
function findAgentTerminalTabs(agentId: string) {
  return getAllTerminalTabs().filter((tab) => {
    if (tab.contentType !== "terminal") return false;
    const cfg = tab.config.config as { agentId?: string };
    return cfg.agentId === agentId;
  });
}

describe("applyAgentReconnecting (G8, #1242)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
  });

  it("routes a sessionId-less agent tab to terminalWaitingForAgent", () => {
    const store = useAppStore.getState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const tab = getAllTerminalTabs()[0];
    // Mid connection.create: no session established yet.
    expect(tab.sessionId).toBeNull();

    applyAgentReconnecting("agent-1", findAgentTerminalTabs("agent-1"), undefined);

    const state = useAppStore.getState();
    // The tab is parked waiting for this agent (honest feedback), not skipped.
    expect(state.terminalWaitingForAgent[tab.id]).toBe("agent-1");
    // It must not be shown the reconnecting spinner (that's for live sessions).
    expect(state.terminalReconnectingTabs[tab.id]).toBeUndefined();
  });

  it("marks an active-session agent tab as reconnecting (unchanged)", () => {
    const store = useAppStore.getState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const tab = getAllTerminalTabs()[0];
    useAppStore.getState().setTabSessionId(tab.id, "session-123");

    applyAgentReconnecting("agent-1", findAgentTerminalTabs("agent-1"), undefined);

    const state = useAppStore.getState();
    expect(state.terminalReconnectingTabs[tab.id]).toBe(true);
    // A live-session tab is not parked as waiting.
    expect(state.terminalWaitingForAgent[tab.id]).toBeUndefined();
  });

  it("records the trigger error on reconnecting active-session tabs", () => {
    const store = useAppStore.getState();
    store.addTab("Shell", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const tab = getAllTerminalTabs()[0];
    useAppStore.getState().setTabSessionId(tab.id, "session-123");

    applyAgentReconnecting("agent-1", findAgentTerminalTabs("agent-1"), "connection reset");

    const state = useAppStore.getState();
    expect(state.terminalReconnectingTabs[tab.id]).toBe(true);
    expect(state.terminalReconnectTriggerErrors[tab.id]).toBe("connection reset");
  });

  describe("session-lifecycle region fold (#2555, closes the #2554 overlay gap)", () => {
    let transport: FakeSessionTransport;

    beforeEach(() => {
      transport = new FakeSessionTransport();
      setSessionTransportForTest(transport);
      setSessionIntentsEnabled(true);
    });

    afterEach(() => {
      stopSessionSubscription();
      setSessionTransportForTest(null);
      setSessionIntentsEnabled(null);
    });

    it("folds a live-session agent tab to reconnecting in the region (overlay/tab-dot source)", () => {
      const store = useAppStore.getState();
      store.addTab("Shell", "remote-session", {
        type: "remote-session",
        config: { agentId: "agent-1", sessionType: "shell" },
      });
      const tab = getAllTerminalTabs()[0];
      useAppStore.getState().setTabSessionId(tab.id, "session-123");

      applyAgentReconnecting("agent-1", findAgentTerminalTabs("agent-1"), "connection reset");

      // Gap-free: the region — the sole reconnecting source the overlay/tab dot
      // read after #2554 — now shows reconnecting for the transient break, with
      // the loop idle (no redrive) and the trigger cause recorded.
      const life = currentSessionView()[tab.id];
      expect(life?.status).toBe("reconnecting");
      expect(life?.reconnect.phase).toBe("idle");
      expect(life?.reconnectError).toBe("connection reset");
    });

    it("does not fold a spawning (sessionId-less) tab — it parks waiting instead", () => {
      const store = useAppStore.getState();
      store.addTab("Spawning", "remote-session", {
        type: "remote-session",
        config: { agentId: "agent-1", sessionType: "shell" },
      });
      const tab = getAllTerminalTabs()[0];

      applyAgentReconnecting("agent-1", findAgentTerminalTabs("agent-1"), undefined);

      expect(currentSessionView()[tab.id]).toBeUndefined();
      expect(useAppStore.getState().terminalWaitingForAgent[tab.id]).toBe("agent-1");
    });
  });

  it("handles a mix: live tab reconnecting, spawning tab waiting", () => {
    const store = useAppStore.getState();
    store.addTab("Live", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    store.addTab("Spawning", "remote-session", {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "shell" },
    });
    const [live, spawning] = getAllTerminalTabs();
    useAppStore.getState().setTabSessionId(live.id, "session-live");
    // `spawning` has no sessionId.

    applyAgentReconnecting("agent-1", findAgentTerminalTabs("agent-1"), undefined);

    const state = useAppStore.getState();
    expect(state.terminalReconnectingTabs[live.id]).toBe(true);
    expect(state.terminalWaitingForAgent[live.id]).toBeUndefined();
    expect(state.terminalWaitingForAgent[spawning.id]).toBe("agent-1");
    expect(state.terminalReconnectingTabs[spawning.id]).toBeUndefined();
  });
});
