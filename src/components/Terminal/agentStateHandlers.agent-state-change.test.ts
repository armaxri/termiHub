/**
 * Tests for the real `agent-state-change` handler (TFE2-001, #4309).
 *
 * These call {@link handleAgentStateChange} — the exact function
 * `TerminalView` registers with `listen` — rather than a
 * copy of their loops, so the tests cannot drift from the shipped code.
 *
 * SM2-001 regression: a user Disconnect/Shutdown of an agent used to fold every
 * hosted tab into `reconnecting`. The disconnect deletes the agent's retained
 * transport config, so the backend redrive could never succeed and the tabs
 * spun through minutes of "Reconnecting…" before a confusing failure. A
 * deliberate disconnect now ends the tabs cleanly (region `disconnected`, reason
 * `user`) with a manual Reconnect, while an unexpected loss still reconnects.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAllLeaves } from "@/utils/panelTree";
import type { PanelNode, TerminalTab } from "@/types/terminal";
import type { AgentSessionInfo } from "@/types/generated/AgentSessionInfo";
import { useAppStore } from "@/store/appStore";
import { layoutState, seedLayoutState } from "@/test/layoutState";
import { setupAgentsRegion } from "@/test/agentsRegionTestHarness";
import { currentSessionView, ensureSessionSubscribed, regionExited } from "@/store/sessionBridge";
import {
  connected,
  disconnected,
  failed,
  installSessionLifecycleHarness,
  reconnecting,
  sessionLost,
} from "@/test/sessionLifecycleRegionTestHarness";
import {
  markAgentDisconnectIntent,
  resetAgentDisconnectIntentsForTest,
} from "@/store/agentDisconnectIntent";
import { disconnectAgent, shutdownAgent } from "@/services/api";
import { handleAgentStateChange, type AgentEndReason } from "./agentStateHandlers";

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
  disconnectAgent: vi.fn(() => Promise.resolve()),
  shutdownAgent: vi.fn(() => Promise.resolve(2)),
  closeTerminal: vi.fn(() => Promise.resolve()),
  listAgentSessions: vi.fn(() => Promise.resolve([])),
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

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

const AGENT = "agent-1";

/** Every tab across all groups (what the handler's default tab source returns). */
function allTabs(): TerminalTab[] {
  return layoutState().tabGroups.flatMap((g) => getAllLeaves(g.rootPanel).flatMap((l) => l.tabs));
}

/** Open an agent-hosted shell tab, optionally with an established session. */
function openAgentTab(sessionId: string | null, agentId: string = AGENT): TerminalTab {
  const before = new Set(allTabs().map((t) => t.id));
  layoutState().addTab("Shell", "remote-session", {
    type: "remote-session",
    config: { agentId, sessionType: "shell" },
  });
  const tab = allTabs().find((t) => !before.has(t.id));
  if (!tab) throw new Error("tab was not added");
  if (sessionId) useAppStore.getState().setTabSessionId(tab.id, sessionId);
  return { ...tab, sessionId };
}

function sessions(...ids: string[]): AgentSessionInfo[] {
  return ids.map((sessionId) => ({ sessionId }) as AgentSessionInfo);
}

setupAgentsRegion();

describe("handleAgentStateChange (real handler, #4309)", () => {
  const harness = installSessionLifecycleHarness();

  let listAgentSessions: ReturnType<typeof vi.fn<(agentId: string) => Promise<AgentSessionInfo[]>>>;
  let settleSessionLost: ReturnType<typeof vi.fn>;
  let settleBackendReconnectGaveUp: ReturnType<typeof vi.fn>;

  /** The `session.*` intents of `kind` the handler dispatched for `tabId`. */
  function intents(kind: string, tabId: string): unknown[] {
    return harness.transport.dispatched
      .filter((i) => i.kind === kind)
      .filter((i) => (i.payload as { sessionId?: string }).sessionId === tabId);
  }

  /** Run the real agent handler with the test's mocked session list. */
  function agentEvent(state: string, error?: string, agentId: string = AGENT): Promise<void> {
    return handleAgentStateChange(
      { session_id: agentId, state, ...(error !== undefined ? { error } : {}) },
      { listAgentSessions, getAllTabs: allTabs }
    );
  }

  beforeEach(async () => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
    resetAgentDisconnectIntentsForTest();
    listAgentSessions = vi.fn<(agentId: string) => Promise<AgentSessionInfo[]>>(() =>
      Promise.resolve([])
    );
    // Spy on the two settle actions while keeping their real behaviour.
    const realSettleLost = useAppStore.getState().settleSessionLost;
    const realGaveUp = useAppStore.getState().settleBackendReconnectGaveUp;
    settleSessionLost = vi.fn((tabId: string) => realSettleLost(tabId));
    settleBackendReconnectGaveUp = vi.fn((tabId: string, error: string) =>
      realGaveUp(tabId, error)
    );
    useAppStore.setState({
      settleSessionLost: settleSessionLost as never,
      settleBackendReconnectGaveUp: settleBackendReconnectGaveUp as never,
    });
    await ensureSessionSubscribed();
  });

  // ── Tab discovery ─────────────────────────────────────────────────────────

  describe("tab discovery", () => {
    it("acts on this agent's terminal tabs only, found via config.agentId", async () => {
      const mine = openAgentTab(null);
      const other = openAgentTab(null, "agent-2");

      await agentEvent("reconnecting");

      // A spawning tab of the reconnecting agent is parked; the other agent's is not.
      expect(useAppStore.getState().terminalWaitingForAgent[mine.id]).toBe(AGENT);
      expect(useAppStore.getState().terminalWaitingForAgent[other.id]).toBeUndefined();
    });

    it("ignores non-terminal tabs that happen to carry an agentId", async () => {
      openAgentTab(null);
      const panel = layoutState().getAllPanels()[0];
      seedLayoutState({
        rootPanel: injectTabIntoPanel(layoutState().rootPanel, panel.id, {
          id: "non-terminal-tab",
          title: "Settings",
          contentType: "settings",
          connectionType: "local",
          sessionId: null,
          panelId: panel.id,
          isActive: false,
          config: { type: "settings", config: { agentId: AGENT } },
        }),
      });

      await agentEvent("reconnecting");

      expect(useAppStore.getState().terminalWaitingForAgent["non-terminal-tab"]).toBeUndefined();
    });

    it("records the agent's connection state", async () => {
      const setAgentConnectionState = vi.fn();
      useAppStore.setState({ setAgentConnectionState: setAgentConnectionState as never });

      await agentEvent("reconnecting", "link lost");

      expect(setAgentConnectionState).toHaveBeenCalledWith(AGENT, "reconnecting", "link lost");
    });
  });

  // ── reconnecting ──────────────────────────────────────────────────────────

  describe("'reconnecting'", () => {
    it("leaves a live-session tab to the backend fold (#2556)", async () => {
      const tab = openAgentTab("session-123");

      await agentEvent("reconnecting");

      expect(currentSessionView()[tab.id]?.status).not.toBe("reconnecting");
      expect(useAppStore.getState().terminalWaitingForAgent[tab.id]).toBeUndefined();
    });
  });

  // ── connected (after a drop) ──────────────────────────────────────────────

  describe("'connected': session recovery after a drop", () => {
    function seedReconnecting(tabId: string) {
      harness.transport.setSession(
        tabId,
        reconnecting({ phase: "waiting", attempt: 0, delayMs: 1000 })
      );
    }

    it("resumes a tab whose session the agent recovered", async () => {
      const tab = openAgentTab("session-123");
      seedReconnecting(tab.id);
      listAgentSessions.mockResolvedValue(sessions("session-123"));

      await agentEvent("connected");

      expect(listAgentSessions).toHaveBeenCalledWith(AGENT);
      expect(settleSessionLost).not.toHaveBeenCalled();
      expect(regionExited(currentSessionView()[tab.id])).toBe(false);
    });

    it("settles a tab whose session was not recovered as session-lost", async () => {
      const tab = openAgentTab("session-123");
      seedReconnecting(tab.id);
      listAgentSessions.mockResolvedValue(sessions());

      await agentEvent("connected");

      expect(settleSessionLost).toHaveBeenCalledWith(tab.id);
    });

    it("accepts the backend's already-folded sessionLost status (race)", async () => {
      const tab = openAgentTab("session-123");
      harness.transport.setSession(tab.id, sessionLost());

      await agentEvent("connected");

      expect(settleSessionLost).toHaveBeenCalledWith(tab.id);
      expect(regionExited(currentSessionView()[tab.id])).toBe(true);
    });

    it("handles mixed recovery: resumes survivors, settles the rest", async () => {
      const a = openAgentTab("session-aaa");
      const b = openAgentTab("session-bbb");
      seedReconnecting(a.id);
      seedReconnecting(b.id);
      listAgentSessions.mockResolvedValue(sessions("session-aaa"));

      await agentEvent("connected");

      expect(settleSessionLost).toHaveBeenCalledTimes(1);
      expect(settleSessionLost).toHaveBeenCalledWith(b.id);
    });

    it("treats every session as gone when listAgentSessions fails (safe fallback)", async () => {
      const tab = openAgentTab("session-123");
      seedReconnecting(tab.id);
      listAgentSessions.mockRejectedValue(new Error("agent unreachable"));

      await agentEvent("connected");

      expect(settleSessionLost).toHaveBeenCalledWith(tab.id);
    });

    it("leaves tabs that were not in the break alone", async () => {
      const tab = openAgentTab("session-123");
      harness.transport.setSession(tab.id, connected());

      await agentEvent("connected");

      expect(settleSessionLost).not.toHaveBeenCalled();
      expect(regionExited(currentSessionView()[tab.id])).toBe(false);
    });

    it("wakes a tab parked waiting for this agent", async () => {
      const tab = openAgentTab(null);
      useAppStore.getState().setTerminalWaitingForAgent(tab.id, AGENT);

      await agentEvent("connected");

      expect(useAppStore.getState().terminalWaitingForAgent[tab.id]).toBeUndefined();
      expect(useAppStore.getState().terminalRetryCounters[tab.id]).toBe(1);
    });

    it("restarts a tab sitting in a connection-failed overlay", async () => {
      const tab = openAgentTab(null);
      useAppStore.getState().setTerminalSpawnError(tab.id, "Connection refused");

      await agentEvent("connected");

      expect(useAppStore.getState().terminalSpawnErrors[tab.id]).toBeUndefined();
      expect(useAppStore.getState().terminalRetryCounters[tab.id]).toBe(1);
    });
  });

  // ── disconnected: unexpected loss ─────────────────────────────────────────

  describe("'disconnected': unexpected loss keeps reconnecting", () => {
    it("arms the backend reconnect for a live agent tab", async () => {
      const tab = openAgentTab("session-123");
      harness.transport.setSession(tab.id, connected());

      await agentEvent("disconnected");

      expect(intents("session.reconnect", tab.id)).toHaveLength(1);
    });

    it("arms the reconnect for a tab the region has not seen yet", async () => {
      const tab = openAgentTab("session-123");

      await agentEvent("disconnected");

      expect(intents("session.reconnect", tab.id)).toHaveLength(1);
    });

    it("skips tabs without an established session", async () => {
      const tab = openAgentTab(null);

      await agentEvent("disconnected");

      expect(intents("session.reconnect", tab.id)).toHaveLength(0);
    });

    it("clears the agent's live-session list", async () => {
      const clearAgentSessions = vi.fn();
      useAppStore.setState({ clearAgentSessions: clearAgentSessions as never });

      await agentEvent("disconnected");

      expect(clearAgentSessions).toHaveBeenCalledWith(AGENT);
    });

    it("settles a backend give-up (error) without re-driving the region", async () => {
      const tab = openAgentTab("session-123");
      const errorMsg = "Failed to reconnect after 10 attempts";
      harness.transport.setSession(tab.id, failed(errorMsg));

      await agentEvent("disconnected", errorMsg);

      expect(settleBackendReconnectGaveUp).toHaveBeenCalledWith(tab.id, errorMsg);
      expect(intents("session.reconnect", tab.id)).toHaveLength(0);
      const life = currentSessionView()[tab.id];
      expect(life?.status).toBe("failed");
      expect(life?.error).toBe(errorMsg);
      expect(regionExited(life)).toBe(true);
    });
  });

  // ── disconnected: the user's Stop on a tab is respected ───────────────────

  describe("'disconnected': a tab the user stopped is never auto-reconnected", () => {
    it("leaves a tab whose reconnect the user stopped (disconnected / user)", async () => {
      const tab = openAgentTab("session-123");
      harness.transport.setSession(tab.id, disconnected("user"));

      await agentEvent("disconnected");

      expect(intents("session.reconnect", tab.id)).toHaveLength(0);
      expect(currentSessionView()[tab.id]?.status).toBe("disconnected");
    });

    it("leaves a tab the user just disconnected whose kill is still in flight", async () => {
      const tab = openAgentTab("session-123");
      harness.transport.setSession(tab.id, connected());
      useAppStore.getState().markSessionKilled("session-123");

      await agentEvent("disconnected");

      expect(intents("session.reconnect", tab.id)).toHaveLength(0);
    });

    it("leaves tabs that had already ended (session lost / failed)", async () => {
      const lost = openAgentTab("session-a");
      const gaveUp = openAgentTab("session-b");
      harness.transport.setSession(lost.id, sessionLost());
      harness.transport.setSession(gaveUp.id, failed("boom"));

      await agentEvent("disconnected");

      expect(intents("session.reconnect", lost.id)).toHaveLength(0);
      expect(intents("session.reconnect", gaveUp.id)).toHaveLength(0);
      expect(currentSessionView()[lost.id]?.status).toBe("sessionLost");
      expect(currentSessionView()[gaveUp.id]?.status).toBe("failed");
    });
  });

  // ── disconnected: deliberate Disconnect / Shutdown ────────────────────────

  describe("'disconnected' after a user Disconnect / Shutdown ends tabs cleanly", () => {
    /** Assert the tab landed on the stable agent-disconnected state. */
    function expectStableAgentDisconnected(tabId: string) {
      // A user end: `session.disconnect` (region → disconnected, reason user),
      // never the `session.reconnect` that arms the backend redrive.
      expect(intents("session.reconnect", tabId)).toHaveLength(0);
      expect(intents("session.disconnect", tabId)).toHaveLength(1);
      // Manual Reconnect is offered through the view-mode banner.
      const s = useAppStore.getState();
      expect(s.terminalViewMode[tabId]).toBe(true);
      expect(s.terminalAgentDisconnected[tabId]).toBe(true);
    }

    it("Disconnect: no reconnect loop, a stable disconnected state", async () => {
      const tab = openAgentTab("session-123");
      harness.transport.setSession(tab.id, connected());

      await useAppStore.getState().disconnectRemoteAgent(AGENT);
      await agentEvent("disconnected");

      expect(disconnectAgent).toHaveBeenCalledWith(AGENT);
      expectStableAgentDisconnected(tab.id);
    });

    it("Shutdown: same as Disconnect", async () => {
      const tab = openAgentTab("session-123");
      harness.transport.setSession(tab.id, connected());

      await useAppStore.getState().shutdownRemoteAgent(AGENT);
      await agentEvent("disconnected");

      expect(shutdownAgent).toHaveBeenCalledWith(AGENT);
      expectStableAgentDisconnected(tab.id);
    });

    it("works when the event lands before the disconnect request resolves", async () => {
      const tab = openAgentTab("session-123");
      harness.transport.setSession(tab.id, connected());
      let resolve: () => void = () => {};
      vi.mocked(disconnectAgent).mockImplementationOnce(
        () => new Promise<void>((r) => (resolve = r))
      );

      const pending = useAppStore.getState().disconnectRemoteAgent(AGENT);
      await agentEvent("disconnected");
      resolve();
      await pending;

      expectStableAgentDisconnected(tab.id);
    });

    it("stops a tab that was mid-reconnect when the user disconnected", async () => {
      const tab = openAgentTab("session-123");
      harness.transport.setSession(
        tab.id,
        reconnecting({ phase: "waiting", attempt: 2, delayMs: 4000 })
      );

      markAgentDisconnectIntent(AGENT);
      await agentEvent("disconnected");

      expectStableAgentDisconnected(tab.id);
    });

    it("leaves tabs that had already ended untouched", async () => {
      const tab = openAgentTab("session-123");
      harness.transport.setSession(tab.id, sessionLost());

      markAgentDisconnectIntent(AGENT);
      await agentEvent("disconnected");

      expect(intents("session.disconnect", tab.id)).toHaveLength(0);
      expect(currentSessionView()[tab.id]?.status).toBe("sessionLost");
    });

    it("applies to one event only — a later unexpected loss reconnects again", async () => {
      const tab = openAgentTab("session-123");
      markAgentDisconnectIntent(AGENT);
      await agentEvent("disconnected");

      // The user reconnects the tab; later the agent drops on its own.
      harness.transport.setSession(tab.id, connected());
      await agentEvent("disconnected");

      expect(intents("session.reconnect", tab.id)).toHaveLength(1);
    });

    it("a stale intent is dropped once the agent connects again", async () => {
      const tab = openAgentTab("session-123");
      markAgentDisconnectIntent(AGENT);

      await agentEvent("connecting");
      harness.transport.setSession(tab.id, connected());
      await agentEvent("disconnected");

      expect(intents("session.reconnect", tab.id)).toHaveLength(1);
    });

    it("a failed disconnect request leaves no intent behind", async () => {
      const tab = openAgentTab("session-123");
      harness.transport.setSession(tab.id, connected());
      vi.mocked(disconnectAgent).mockRejectedValueOnce(new Error("nope"));

      await useAppStore.getState().disconnectRemoteAgent(AGENT);
      await agentEvent("disconnected");

      expect(intents("session.reconnect", tab.id)).toHaveLength(1);
    });

    it("a failed shutdown request leaves no intent behind", async () => {
      const tab = openAgentTab("session-123");
      harness.transport.setSession(tab.id, connected());
      vi.mocked(shutdownAgent).mockRejectedValueOnce(new Error("nope"));

      await expect(useAppStore.getState().shutdownRemoteAgent(AGENT)).rejects.toThrow("nope");
      await agentEvent("disconnected");

      expect(intents("session.reconnect", tab.id)).toHaveLength(1);
    });

    it("a suspend-style disconnect (agent update, force reconnect) keeps tabs resumable", async () => {
      const tab = openAgentTab("session-123");
      harness.transport.setSession(tab.id, connected());

      await useAppStore.getState().disconnectRemoteAgent(AGENT, { endHostedSessions: false });
      await agentEvent("disconnected");

      // The backend is told too, so it reports a suspend to every window (#4447).
      expect(disconnectAgent).toHaveBeenCalledWith(AGENT, { endHostedSessions: false });
      expect(intents("session.reconnect", tab.id)).toHaveLength(1);
      expect(useAppStore.getState().terminalAgentDisconnected[tab.id]).toBeUndefined();
    });

    it("a manual Reconnect clears the agent-disconnected marker", async () => {
      const tab = openAgentTab("session-123");
      markAgentDisconnectIntent(AGENT);
      await agentEvent("disconnected");

      useAppStore.getState().reconnectTerminal(tab.id);

      expect(useAppStore.getState().terminalAgentDisconnected[tab.id]).toBeUndefined();
    });
  });

  // ── backend end reason, seen by a window that clicked nothing (#4447) ────

  describe("'disconnected' with a backend end reason (any window)", () => {
    /** Deliver a "disconnected" event carrying the backend's end reason. */
    function disconnectedWith(reason: AgentEndReason): Promise<void> {
      return handleAgentStateChange(
        { session_id: AGENT, state: "disconnected", reason },
        { listAgentSessions, getAllTabs: allTabs }
      );
    }

    it.each<AgentEndReason>(["user", "shutdown"])(
      "reason '%s' ends the tabs of a window with no local intent",
      async (reason) => {
        const tab = openAgentTab("session-123");
        harness.transport.setSession(tab.id, connected());

        await disconnectedWith(reason);

        expect(intents("session.reconnect", tab.id)).toHaveLength(0);
        expect(intents("session.disconnect", tab.id)).toHaveLength(1);
        expect(useAppStore.getState().terminalViewMode[tab.id]).toBe(true);
        expect(useAppStore.getState().terminalAgentDisconnected[tab.id]).toBe(true);
      }
    );

    it("a user end leaves tabs that had already ended untouched", async () => {
      const tab = openAgentTab("session-123");
      harness.transport.setSession(tab.id, sessionLost());

      await disconnectedWith("user");

      expect(intents("session.disconnect", tab.id)).toHaveLength(0);
      expect(currentSessionView()[tab.id]?.status).toBe("sessionLost");
    });

    it.each<AgentEndReason>(["lost", "suspend"])(
      "reason '%s' still reconnects the tab",
      async (reason) => {
        const tab = openAgentTab("session-123");
        harness.transport.setSession(tab.id, connected());

        await disconnectedWith(reason);

        expect(intents("session.reconnect", tab.id)).toHaveLength(1);
        expect(intents("session.disconnect", tab.id)).toHaveLength(0);
        expect(useAppStore.getState().terminalAgentDisconnected[tab.id]).toBeUndefined();
      }
    );

    it("a user end consumes this window's own intent too", async () => {
      const tab = openAgentTab("session-123");
      markAgentDisconnectIntent(AGENT);
      await disconnectedWith("user");

      // The user reconnects; a later unexpected loss must reconnect, not end.
      harness.transport.setSession(tab.id, connected());
      await disconnectedWith("lost");

      expect(intents("session.reconnect", tab.id)).toHaveLength(1);
    });
  });
});

/** Inject a tab into a named leaf panel. */
function injectTabIntoPanel(node: PanelNode, panelId: string, tab: unknown): PanelNode {
  if (node.type === "leaf") {
    if (node.id === panelId) {
      return { ...node, tabs: [...node.tabs, tab as TerminalTab] };
    }
    return node;
  }
  return {
    ...node,
    children: node.children.map((child) => injectTabIntoPanel(child, panelId, tab)),
  };
}
