import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The auto-reconnect loop lives entirely in the store and its pure state machine;
// it never calls the backend directly (it re-drives the existing reconnect path),
// so the service mocks only need to satisfy module import.
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
  startPersistentSession: vi.fn(() => Promise.resolve("sid")),
  stopPersistentSession: vi.fn(() => Promise.resolve()),
  attachPersistentTab: vi.fn(() => Promise.resolve(1)),
  connectAgent: vi.fn(() => Promise.resolve({ capabilities: {} })),
  disconnectAgent: vi.fn(),
  listAgentSessions: vi.fn(() => Promise.resolve([])),
  listAgentConnections: vi.fn(() => Promise.resolve({ connections: [], folders: [] })),
  saveAgentDefinition: vi.fn(),
  updateAgentDefinition: vi.fn(),
  deleteAgentDefinition: vi.fn(() => Promise.resolve()),
  createAgentFolder: vi.fn(),
  updateAgentFolder: vi.fn(() => Promise.resolve({})),
  deleteAgentFolder: vi.fn(() => Promise.resolve()),
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  removeCredential: vi.fn(() => Promise.resolve()),
  getConnectionTypes: vi.fn(() => Promise.resolve([])),
  sessionGetCapabilities: vi.fn(() => Promise.resolve({})),
}));

import { useAppStore } from "./appStore";
import { getAllLeaves } from "@/utils/panelTree";
import { DEFAULT_BACKOFF } from "@/utils/reconnectBackoff";
import { registerTerminalInputInjector } from "@/services/macroPlayback";
import { setSessionIntentsEnabled } from "./sessionBridge";

function findTab(tabId: string) {
  const state = useAppStore.getState();
  return [
    ...getAllLeaves(state.rootPanel).flatMap((l) => l.tabs),
    ...state.tabGroups.flatMap((g) => getAllLeaves(g.rootPanel).flatMap((l) => l.tabs)),
  ].find((t) => t.id === tabId);
}

/** Create a plain-SSH terminal tab; `resilient` toggles the per-connection opt-in. */
function makeSshTab(
  resilient: boolean,
  sessionId: string | null = "sess-1",
  onReconnectCommand?: string
): string {
  return useAppStore.getState().addTab(
    "web01",
    "ssh",
    {
      type: "ssh",
      config: {
        host: "web01.example.com",
        username: "deploy",
        resilientReconnect: resilient,
        ...(onReconnectCommand !== undefined ? { onReconnectCommand } : {}),
      },
    },
    { contentType: "terminal", sessionId }
  );
}

const auto = (tabId: string) => useAppStore.getState().terminalAutoReconnect[tabId];

describe("appStore — agentless auto-reconnect (#1962)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.useFakeTimers();
    // Pin the local `setTimeout` reconnect loop: these tests assert the local
    // reducer/timer path, which stays as the resilience fallback after the
    // session mutation cut flipped on by default (#2152). The intent path keeps
    // its own coverage in sessionBridge/appStore.sessionBridge tests.
    setSessionIntentsEnabled(false);
  });

  afterEach(() => {
    setSessionIntentsEnabled(null);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("starts a backoff loop when an opted-in SSH tab drops unexpectedly", () => {
    const tabId = makeSshTab(true);

    useAppStore.getState().setTerminalExited(tabId, { code: null, reason: "dropped" });

    const state = auto(tabId);
    expect(state).toBeDefined();
    expect(state.phase).toBe("waiting");
    expect(state.attempt).toBe(0);
    expect(state.maxAttempts).toBe(DEFAULT_BACKOFF.maxAttempts);
    // First delay is the base delay ± jitter.
    expect(state.delayMs).toBeGreaterThan(0);
    expect(state.delayMs).toBeLessThanOrEqual(
      Math.round(DEFAULT_BACKOFF.baseDelayMs * (1 + DEFAULT_BACKOFF.jitterRatio)) + 1
    );
  });

  it("does NOT auto-reconnect when the connection did not opt in", () => {
    const tabId = makeSshTab(false);
    useAppStore.getState().setTerminalExited(tabId, { code: null, reason: "dropped" });
    expect(auto(tabId)).toBeUndefined();
    // The standard disconnect overlay path still applies.
    expect(useAppStore.getState().terminalExitedTabs[tabId]).toBe(true);
  });

  it("does NOT auto-reconnect on a clean exit or a user kill", () => {
    const cleanTab = makeSshTab(true);
    useAppStore.getState().setTerminalExited(cleanTab, { code: 0, reason: "clean" });
    expect(auto(cleanTab)).toBeUndefined();

    const killedTab = makeSshTab(true);
    useAppStore.getState().setTerminalExited(killedTab, { code: null, reason: "killed" });
    expect(auto(killedTab)).toBeUndefined();
  });

  it("fires the connect attempt when the backoff timer elapses", () => {
    const tabId = makeSshTab(true);
    useAppStore.getState().setTerminalExited(tabId, { code: null, reason: "dropped" });
    const retryBefore = useAppStore.getState().terminalRetryCounters[tabId] ?? 0;

    vi.advanceTimersByTime(auto(tabId).delayMs);

    const state = auto(tabId);
    expect(state.phase).toBe("connecting");
    expect(state.attempt).toBe(1);
    // reconnectTerminal was invoked → retry counter bumped, connecting overlay armed.
    expect(useAppStore.getState().terminalRetryCounters[tabId]).toBe(retryBefore + 1);
    expect(useAppStore.getState().terminalConnecting[tabId]).toBe(true);
  });

  it("settles the loop when the reconnect attempt succeeds", () => {
    const tabId = makeSshTab(true);
    useAppStore.getState().setTerminalExited(tabId, { code: null, reason: "dropped" });
    vi.advanceTimersByTime(auto(tabId).delayMs);
    expect(auto(tabId).phase).toBe("connecting");

    // A session id landing is the success signal.
    useAppStore.getState().setTabSessionId(tabId, "sess-2");

    expect(auto(tabId)).toBeUndefined();
  });

  it("backs off further after a failed attempt, with a longer delay", () => {
    const tabId = makeSshTab(true);
    useAppStore.getState().setTerminalExited(tabId, { code: null, reason: "dropped" });

    vi.advanceTimersByTime(auto(tabId).delayMs); // attempt 1 (connecting)
    expect(auto(tabId).phase).toBe("connecting");

    // A direct-SSH failed attempt surfaces via setTerminalSpawnError.
    useAppStore.getState().setTerminalSpawnError(tabId, "connection refused");

    const state = auto(tabId);
    expect(state.phase).toBe("waiting");
    expect(state.attempt).toBe(1);
    // Delay for attempt #2 is around base*factor, larger than the base window.
    expect(state.delayMs).toBeGreaterThan(
      Math.round(DEFAULT_BACKOFF.baseDelayMs * (1 - DEFAULT_BACKOFF.jitterRatio))
    );
    // The failed attempt's spawn error is suppressed so it does not compete with
    // the countdown overlay.
    expect(useAppStore.getState().terminalSpawnErrors[tabId]).toBeUndefined();
  });

  it("gives up after exhausting maxAttempts and shows the reconnect-failed overlay", () => {
    const tabId = makeSshTab(true);
    useAppStore.getState().setTerminalExited(tabId, { code: null, reason: "dropped" });

    // Drive attempt→failure until the loop gives up.
    for (let i = 0; i < DEFAULT_BACKOFF.maxAttempts; i++) {
      const state = auto(tabId);
      if (!state) break;
      expect(state.phase).toBe("waiting");
      vi.advanceTimersByTime(state.delayMs);
      expect(auto(tabId).phase).toBe("connecting");
      useAppStore.getState().setTerminalSpawnError(tabId, "connection refused");
    }

    // Loop cleared; the standard "Reconnect failed" overlay takes over.
    expect(auto(tabId)).toBeUndefined();
    expect(useAppStore.getState().terminalExitedTabs[tabId]).toBe(true);
    expect(useAppStore.getState().terminalDisconnectErrors[tabId]).toBe("connection refused");
  });

  it("cancel stops the loop and leaves the manual disconnect overlay", () => {
    const tabId = makeSshTab(true);
    useAppStore.getState().setTerminalExited(tabId, { code: null, reason: "dropped" });
    expect(auto(tabId).phase).toBe("waiting");

    useAppStore.getState().cancelAutoReconnect(tabId);

    expect(auto(tabId)).toBeUndefined();
    expect(useAppStore.getState().terminalExitedTabs[tabId]).toBe(true);
    // A cancelled loop must not schedule any further attempt.
    const retryBefore = useAppStore.getState().terminalRetryCounters[tabId] ?? 0;
    vi.advanceTimersByTime(60_000);
    expect(useAppStore.getState().terminalRetryCounters[tabId] ?? 0).toBe(retryBefore);
  });

  it("cancel is a no-op when no loop is active", () => {
    const tabId = makeSshTab(true);
    expect(() => useAppStore.getState().cancelAutoReconnect(tabId)).not.toThrow();
    expect(auto(tabId)).toBeUndefined();
  });

  it("a re-drop after a successful reconnect restarts the loop", () => {
    const tabId = makeSshTab(true);
    useAppStore.getState().setTerminalExited(tabId, { code: null, reason: "dropped" });
    vi.advanceTimersByTime(auto(tabId).delayMs);
    useAppStore.getState().setTabSessionId(tabId, "sess-2");
    expect(auto(tabId)).toBeUndefined();

    // Link drops again → fresh loop from attempt 1.
    useAppStore.getState().setTerminalExited(tabId, { code: null, reason: "dropped" });
    expect(auto(tabId).phase).toBe("waiting");
    expect(auto(tabId).attempt).toBe(0);
  });

  it("clears the pending backoff timer when the tab is closed", () => {
    const tabId = makeSshTab(true);
    useAppStore.getState().setTerminalExited(tabId, { code: null, reason: "dropped" });
    expect(auto(tabId).phase).toBe("waiting");

    const panelId = findTab(tabId)!.panelId;
    useAppStore.getState().closeTab(tabId, panelId);

    expect(auto(tabId)).toBeUndefined();
    // No timer should fire against the gone tab.
    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
    expect(findTab(tabId)).toBeUndefined();
  });
});

describe("appStore — on-reconnect command (#1978)", () => {
  let injected: Array<{ tabId: string; data: string }>;

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.useFakeTimers();
    // Pin the local `setTimeout` reconnect loop — see the note above. The local
    // reducer/timer path is the resilience fallback after the session mutation
    // cut flipped on by default (#2152).
    setSessionIntentsEnabled(false);
    injected = [];
    registerTerminalInputInjector((tabId, data) => {
      injected.push({ tabId, data });
      return Promise.resolve(true);
    });
  });

  afterEach(() => {
    setSessionIntentsEnabled(null);
    registerTerminalInputInjector(null);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  /** Drive a tab through drop → attempt → successful reconnect. */
  function reconnectSuccessfully(tabId: string): void {
    useAppStore.getState().setTerminalExited(tabId, { code: null, reason: "dropped" });
    vi.advanceTimersByTime(auto(tabId).delayMs);
    expect(auto(tabId).phase).toBe("connecting");
    useAppStore.getState().setTabSessionId(tabId, "sess-2");
    expect(auto(tabId)).toBeUndefined();
  }

  it("runs the configured command once after a successful auto-reconnect", () => {
    const tabId = makeSshTab(true, "sess-1", "tmux attach");

    reconnectSuccessfully(tabId);

    expect(injected).toEqual([{ tabId, data: "tmux attach\n" }]);
  });

  it("trims the command and appends a single newline", () => {
    const tabId = makeSshTab(true, "sess-1", "  screen -r  ");
    reconnectSuccessfully(tabId);
    expect(injected).toEqual([{ tabId, data: "screen -r\n" }]);
  });

  it("does not run anything when no command is configured", () => {
    const tabId = makeSshTab(true, "sess-1");
    reconnectSuccessfully(tabId);
    expect(injected).toEqual([]);
  });

  it("treats a whitespace-only command as no command", () => {
    const tabId = makeSshTab(true, "sess-1", "   ");
    reconnectSuccessfully(tabId);
    expect(injected).toEqual([]);
  });

  it("does not run the command on the initial connect (no active loop)", () => {
    const tabId = makeSshTab(true, null, "tmux attach");
    // A first-ever session id landing with no loop in flight must not fire it.
    useAppStore.getState().setTabSessionId(tabId, "sess-1");
    expect(injected).toEqual([]);
  });

  it("does not run the command when the loop is cancelled before success", () => {
    const tabId = makeSshTab(true, "sess-1", "tmux attach");
    useAppStore.getState().setTerminalExited(tabId, { code: null, reason: "dropped" });
    expect(auto(tabId).phase).toBe("waiting");
    useAppStore.getState().cancelAutoReconnect(tabId);
    expect(injected).toEqual([]);
  });

  it("runs the command again on each subsequent successful reconnect", () => {
    const tabId = makeSshTab(true, "sess-1", "tmux attach");
    reconnectSuccessfully(tabId);
    // A fresh drop and reconnect fires the command a second time.
    useAppStore.getState().setTerminalExited(tabId, { code: null, reason: "dropped" });
    vi.advanceTimersByTime(auto(tabId).delayMs);
    useAppStore.getState().setTabSessionId(tabId, "sess-3");
    expect(injected).toEqual([
      { tabId, data: "tmux attach\n" },
      { tabId, data: "tmux attach\n" },
    ]);
  });

  it("exposes the command in the loop display state for the overlay", () => {
    const tabId = makeSshTab(true, "sess-1", "tmux attach");
    useAppStore.getState().setTerminalExited(tabId, { code: null, reason: "dropped" });
    expect(auto(tabId).onReconnectCommand).toBe("tmux attach");
  });
});
