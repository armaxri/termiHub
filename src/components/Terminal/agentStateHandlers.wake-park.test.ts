/**
 * Agent tab wake / park lifecycle (#3686) — automates the manual items
 * MT-AGENT-11, MT-AGENT-17 and MT-AGENT-30 against the real handler code.
 *
 * The wake-on-connected loop (formerly inline in `TerminalView.tsx`) and the
 * agent connect-failure catch (formerly inline in `Terminal.tsx`) live in
 * `agentStateHandlers.ts`, so these tests drive the exact functions the
 * components call — not a copy of the loop.
 *
 * - **MT-AGENT-11** — a tab opened while the agent is still connecting parks on
 *   "Waiting for agent…" and starts its session automatically once the agent
 *   emits `connected` (the overlay's "Retry now" button and timeout countdown are
 *   covered by `TerminalConnectionOverlay(.timeout).test.tsx`).
 * - **MT-AGENT-17** — reconnecting a tab whose agent connection was destroyed
 *   re-establishes the agent **once**; on success the tab is woken, on failure the
 *   tab shows "Could not reconnect to agent: …" instead of looping.
 * - **MT-AGENT-30** — a tab whose agent drops while it is still spawning parks on
 *   the waiting path and resumes when the agent link is restored.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAllLeaves } from "@/utils/panelTree";
import { useAppStore } from "@/store/appStore";
import { layoutState } from "@/test/layoutState";
import { currentSessionView } from "@/store/sessionBridge";
import { installSessionLifecycleHarness } from "@/test/sessionLifecycleRegionTestHarness";
import { seedAgentsRegion, setupAgentsRegion } from "@/test/agentsRegionTestHarness";
import { DEFAULT_AGENT_SETTINGS, type RemoteAgentDefinition } from "@/types/connection";
import {
  applyAgentReconnecting,
  applyAgentSpawnFailure,
  restartAgentRetryTabs,
  wakeWaitingAgentTabs,
} from "./agentStateHandlers";

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

const AGENT = "agent-1";

/** Collect all terminal tabs from all panels in the current store state. */
function getAllTerminalTabs() {
  const store = layoutState();
  return store.tabGroups.flatMap((g) => getAllLeaves(g.rootPanel).flatMap((l) => l.tabs));
}

/** Same agent-tab filter used by the real `agent-state-change` handler. */
function agentTabs(agentId: string = AGENT) {
  return getAllTerminalTabs().filter((tab) => {
    if (tab.contentType !== "terminal") return false;
    const cfg = tab.config.config as { agentId?: string };
    return cfg.agentId === agentId;
  });
}

/** Open a fresh (sessionId-less) agent tab and return its id. */
function openAgentTab(agentId: string = AGENT, title = "Shell"): string {
  layoutState().addTab(title, "remote-session", {
    type: "remote-session",
    config: { agentId, sessionType: "shell" },
  });
  const tabs = getAllTerminalTabs();
  return tabs[tabs.length - 1].id;
}

function seedAgent(connectionState: RemoteAgentDefinition["connectionState"]): void {
  seedAgentsRegion({
    remoteAgents: [
      {
        id: AGENT,
        name: "Test Agent",
        config: { host: "h", port: 22, username: "u", authMethod: "password" },
        connectionState,
        isExpanded: true,
        agentSettings: DEFAULT_AGENT_SETTINGS,
      },
    ],
  });
}

/**
 * Simulate the `connected` branch's wake + restart steps exactly as
 * `TerminalView` runs them: both gated on one pre-wake store snapshot.
 */
function agentConnected(agentId: string = AGENT) {
  const snapshot = useAppStore.getState();
  const tabs = agentTabs(agentId);
  return {
    woke: wakeWaitingAgentTabs(agentId, tabs, snapshot),
    restarted: restartAgentRetryTabs(tabs, snapshot),
  };
}

const noopClassify = vi.fn();

setupAgentsRegion();

describe("agent tab wake / park (#3686)", () => {
  const harness = installSessionLifecycleHarness();

  /** The `session.connectFailed` intents dispatched to the region (the error fold). */
  function connectFailedIntents(tabId: string): { sessionId: string; error?: string }[] {
    return harness.transport.dispatched
      .filter((i) => i.kind === "session.connectFailed")
      .map((i) => i.payload as { sessionId: string; error?: string })
      .filter((p) => p.sessionId === tabId);
  }

  let connectRemoteAgent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
    connectRemoteAgent = vi.fn(() => Promise.resolve());
    useAppStore.setState({ connectRemoteAgent: connectRemoteAgent as never });
  });

  describe("MT-AGENT-11: waiting-for-agent auto-starts when the agent connects", () => {
    it("parks a tab whose spawn failed while the agent was connecting", () => {
      seedAgent("connecting");
      const tabId = openAgentTab();

      const action = applyAgentSpawnFailure({
        tabId,
        agentId: AGENT,
        err: new Error("Agent not connected"),
        attempt: 0,
        maxAttempts: 5,
        setClassifiedSpawnError: noopClassify,
      });

      expect(action.kind).toBe("waitForAgent");
      expect(useAppStore.getState().terminalWaitingForAgent[tabId]).toBe(AGENT);
      // The waiting overlay's timeout countdown is armed.
      expect(useAppStore.getState().terminalConnectDeadline[tabId]).toBeDefined();
      expect(noopClassify).not.toHaveBeenCalled();
      expect(connectRemoteAgent).not.toHaveBeenCalled();
    });

    it("wakes the parked tab on `connected`: un-parks and re-runs the spawn", () => {
      seedAgent("connecting");
      const tabId = openAgentTab();
      applyAgentSpawnFailure({
        tabId,
        agentId: AGENT,
        err: new Error("Agent not connected"),
        attempt: 0,
        maxAttempts: 5,
        setClassifiedSpawnError: noopClassify,
      });

      seedAgent("connected");
      const { woke, restarted } = agentConnected();

      const state = useAppStore.getState();
      expect(woke).toBe(1);
      expect(state.terminalWaitingForAgent[tabId]).toBeUndefined();
      // retryTerminalSpawn bumps the counter, re-running the Terminal setup effect.
      expect(state.terminalRetryCounters[tabId]).toBe(1);
      expect(state.terminalConnectDeadline[tabId]).toBeUndefined();
      // Judged on the pre-wake snapshot, the restart loop leaves it alone.
      expect(restarted).toBe(0);
    });

    it("does not wake a tab parked on a different agent", () => {
      const other = openAgentTab("agent-2");
      useAppStore.getState().setTerminalWaitingForAgent(other, "agent-2");

      const { woke } = agentConnected(AGENT);

      expect(woke).toBe(0);
      expect(useAppStore.getState().terminalWaitingForAgent[other]).toBe("agent-2");
      expect(useAppStore.getState().terminalRetryCounters[other]).toBeUndefined();
    });

    it("wakes every parked tab of the agent exactly once", () => {
      const a = openAgentTab(AGENT, "A");
      const b = openAgentTab(AGENT, "B");
      useAppStore.getState().setTerminalWaitingForAgent(a, AGENT);
      useAppStore.getState().setTerminalWaitingForAgent(b, AGENT);
      // Leftover auto-retry state on a parked tab must not cause a second wake.
      useAppStore.getState().setTerminalAutoRetrying(b, 2);
      useAppStore.getState().setTerminalWaitingForAgent(b, AGENT);

      const { woke, restarted } = agentConnected();

      expect(woke).toBe(2);
      expect(restarted).toBe(0);
      expect(useAppStore.getState().terminalRetryCounters[a]).toBe(1);
      expect(useAppStore.getState().terminalRetryCounters[b]).toBe(1);
    });
  });

  describe("MT-AGENT-17: reconnect after the agent connection is destroyed", () => {
    it("re-establishes the agent once and parks the tab", () => {
      seedAgent("disconnected");
      const tabId = openAgentTab();

      const action = applyAgentSpawnFailure({
        tabId,
        agentId: AGENT,
        err: new Error("Agent not connected"),
        attempt: 0,
        maxAttempts: 5,
        setClassifiedSpawnError: noopClassify,
      });

      expect(action.kind).toBe("reconnectAgentThenWait");
      expect(connectRemoteAgent).toHaveBeenCalledTimes(1);
      expect(connectRemoteAgent).toHaveBeenCalledWith(AGENT);
      expect(useAppStore.getState().terminalWaitingForAgent[tabId]).toBe(AGENT);
    });

    it("starts a fresh session in the tab once the agent is back", async () => {
      seedAgent("disconnected");
      const tabId = openAgentTab();
      applyAgentSpawnFailure({
        tabId,
        agentId: AGENT,
        err: new Error("Agent not connected"),
        attempt: 0,
        maxAttempts: 5,
        setClassifiedSpawnError: noopClassify,
      });
      await Promise.resolve();

      seedAgent("connected");
      agentConnected();

      expect(useAppStore.getState().terminalWaitingForAgent[tabId]).toBeUndefined();
      expect(useAppStore.getState().terminalRetryCounters[tabId]).toBe(1);
      expect(connectFailedIntents(tabId)).toHaveLength(0);
    });

    it("makes a single reconnect, then shows the error instead of looping", async () => {
      seedAgent("disconnected");
      connectRemoteAgent.mockRejectedValue(new Error("host unreachable"));
      const tabId = openAgentTab();

      applyAgentSpawnFailure({
        tabId,
        agentId: AGENT,
        err: new Error("Agent not connected"),
        attempt: 0,
        maxAttempts: 5,
        setClassifiedSpawnError: noopClassify,
      });
      // The single reconnect fails: the tab folds to a failed state carrying the error.
      await vi.waitFor(() => expect(connectFailedIntents(tabId)).toHaveLength(1));
      expect(connectFailedIntents(tabId)[0].error).toBe(
        "Could not reconnect to agent: host unreachable"
      );

      expect(connectRemoteAgent).toHaveBeenCalledTimes(1);
      expect(useAppStore.getState().terminalWaitingForAgent[tabId]).toBeUndefined();
    });

    it("gives up with the spawn error once the bounded retries are exhausted", () => {
      seedAgent("connected");
      const tabId = openAgentTab();
      useAppStore.getState().setTerminalAutoRetrying(tabId, 5);

      const action = applyAgentSpawnFailure({
        tabId,
        agentId: AGENT,
        err: new Error("no such shell"),
        attempt: 5,
        maxAttempts: 5,
        setClassifiedSpawnError: noopClassify,
      });

      expect(action.kind).toBe("giveUp");
      expect(connectRemoteAgent).not.toHaveBeenCalled();
      expect(useAppStore.getState().terminalAutoRetryCount[tabId]).toBeUndefined();
      expect(connectFailedIntents(tabId)).toHaveLength(1);
      expect(connectFailedIntents(tabId)[0].error).toBe("no such shell");
    });

    it("leaves a transient failure to the caller's retry loop", () => {
      seedAgent("connected");
      const tabId = openAgentTab();

      const action = applyAgentSpawnFailure({
        tabId,
        agentId: AGENT,
        err: new Error("busy"),
        attempt: 1,
        maxAttempts: 5,
        setClassifiedSpawnError: noopClassify,
      });

      expect(action).toEqual({ kind: "retryAfterDelay", attempt: 2 });
      expect(noopClassify).not.toHaveBeenCalled();
      expect(useAppStore.getState().terminalWaitingForAgent[tabId]).toBeUndefined();
      expect(currentSessionView()[tabId]).toBeUndefined();
    });

    it("stops on a typed auth failure with the classified error", () => {
      seedAgent("disconnected");
      const tabId = openAgentTab();
      const err = { code: "auth_failed", message: "Authentication failed" };

      const action = applyAgentSpawnFailure({
        tabId,
        agentId: AGENT,
        err,
        attempt: 0,
        maxAttempts: 5,
        setClassifiedSpawnError: noopClassify,
      });

      expect(action.kind).toBe("authFailed");
      expect(noopClassify).toHaveBeenCalledWith(tabId, err);
      // A rejected credential never triggers an agent reconnect.
      expect(connectRemoteAgent).not.toHaveBeenCalled();
      expect(useAppStore.getState().terminalWaitingForAgent[tabId]).toBeUndefined();
    });
  });

  describe("MT-AGENT-30: a tab that drops while spawning parks and resumes", () => {
    it("parks on `reconnecting`, then resumes on `connected`", () => {
      const tabId = openAgentTab();
      // Still mid connection.create: no session yet.
      expect(agentTabs()[0].sessionId).toBeNull();

      seedAgent("reconnecting");
      applyAgentReconnecting(AGENT, agentTabs(), "connection reset");

      // Honest feedback: waiting-for-agent, not an ambiguous spawn error.
      let state = useAppStore.getState();
      expect(state.terminalWaitingForAgent[tabId]).toBe(AGENT);
      expect(state.terminalSpawnErrors[tabId]).toBeUndefined();
      expect(connectFailedIntents(tabId)).toHaveLength(0);

      // The in-flight spawn then fails while the transport is still reconnecting:
      // it stays parked rather than surfacing an error.
      applyAgentSpawnFailure({
        tabId,
        agentId: AGENT,
        err: new Error("Agent not connected"),
        attempt: 0,
        maxAttempts: 5,
        setClassifiedSpawnError: noopClassify,
      });
      expect(useAppStore.getState().terminalWaitingForAgent[tabId]).toBe(AGENT);
      expect(noopClassify).not.toHaveBeenCalled();

      // Agent link restored: the parked tab retries and opens its session.
      seedAgent("connected");
      const { woke } = agentConnected();
      state = useAppStore.getState();
      expect(woke).toBe(1);
      expect(state.terminalWaitingForAgent[tabId]).toBeUndefined();
      expect(state.terminalRetryCounters[tabId]).toBe(1);
    });

    it("leaves a live-session tab to the backend reconnect and does not wake it", () => {
      const tabId = openAgentTab();
      useAppStore.getState().setTabSessionId(tabId, "session-live");

      applyAgentReconnecting(AGENT, agentTabs(), undefined);
      const { woke } = agentConnected();

      expect(woke).toBe(0);
      expect(useAppStore.getState().terminalWaitingForAgent[tabId]).toBeUndefined();
      expect(useAppStore.getState().terminalRetryCounters[tabId]).toBeUndefined();
    });
  });
});
