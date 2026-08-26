import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Since #2205 PR-B the resilient-reconnect loop is owned by the backend redrive
// via the `session-lifecycle` region — the client no longer runs a backoff engine.
// These tests assert the region-authoritative contract (drop → session.reconnect,
// backend attempt edge → re-drive, cancel → session.cancelReconnect) plus the
// surviving on-reconnect command. The service mocks only satisfy module import.
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

import type {
  FrameHandler,
  Intent,
  IntentAck,
  ProjectionFrame,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";

import { useAppStore } from "./appStore";
import { registerTerminalInputInjector } from "@/services/macroPlayback";
import {
  currentSessionView,
  SESSION_LIFECYCLE_REGION,
  setSessionTransportForTest,
  stopSessionSubscription,
  type ProjectedSessionLifecycle,
} from "./sessionBridge";

/**
 * A `session-lifecycle` substrate double: records dispatched intents and folds
 * the reconnect-relevant ones (`session.reconnect` → reconnecting/waiting) so the
 * region reflects them, plus `fireAttempt` to simulate the backend timer's
 * Waiting→Connecting edge. The client engine is gone (#2205 PR-B), so these tests
 * assert the region-authoritative contract, not a local backoff loop.
 */
class FakeTransport implements Transport {
  dispatched: Intent[] = [];
  private sessions: Record<string, ProjectedSessionLifecycle> = {};
  private version = 0;
  private handlers: FrameHandler[] = [];

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    const id = (intent.payload as { sessionId: string }).sessionId;
    if (intent.kind === "session.reconnect") {
      this.sessions[id] = {
        status: "reconnecting",
        reconnect: { phase: "waiting", attempt: 0, delayMs: 1000 },
      };
      this.version += 1;
      this.fan();
    }
    const produced =
      intent.kind === "session.reconnect"
        ? [{ region: SESSION_LIFECYCLE_REGION, version: this.version }]
        : [];
    return { intentId: intent.intentId, status: "accepted", produced };
  }

  async subscribe(region: string, onFrame: FrameHandler): Promise<Subscription> {
    this.handlers.push(onFrame);
    return {
      snapshot: this.snapshot(region),
      unsubscribe: () => {
        this.handlers = this.handlers.filter((h) => h !== onFrame);
      },
    };
  }

  async resync(): Promise<SnapshotFrame | null> {
    return null;
  }

  kinds(): string[] {
    return this.dispatched.map((i) => i.kind);
  }

  /** Simulate the backend timer firing the Waiting→Connecting edge. */
  fireAttempt(id: string, attempt: number): void {
    this.sessions[id] = {
      status: "reconnecting",
      reconnect: { phase: "connecting", attempt, delayMs: 0 },
    };
    this.version += 1;
    this.fan();
  }

  private snapshot(region: string): SnapshotFrame {
    return {
      kind: "snapshot",
      region,
      version: this.version,
      view: structuredClone({ sessions: this.sessions }),
    };
  }

  private fan(): void {
    const frame: ProjectionFrame = this.snapshot(SESSION_LIFECYCLE_REGION);
    for (const h of this.handlers) h(frame);
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

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

function reconnectKinds(fake: FakeTransport, tabId: string): string[] {
  return fake.dispatched
    .filter((i) => (i.payload as { sessionId: string }).sessionId === tabId)
    .map((i) => i.kind);
}

describe("appStore — resilient reconnect is region-authoritative (#1962 / #2205 PR-B)", () => {
  let fake: FakeTransport;

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    fake = new FakeTransport();
    setSessionTransportForTest(fake);
  });

  afterEach(() => {
    stopSessionSubscription();
    setSessionTransportForTest(null);
  });

  it("folds session.reconnect + region reconnecting when an opted-in SSH tab drops", async () => {
    const tabId = makeSshTab(true);

    useAppStore.getState().setTerminalExited(tabId, { code: null, reason: "dropped" });
    await flush();

    expect(reconnectKinds(fake, tabId)).toContain("session.reconnect");
    expect(currentSessionView()[tabId]?.status).toBe("reconnecting");
    expect(currentSessionView()[tabId]?.reconnect.phase).toBe("waiting");
  });

  it("dispatches session.dropped (not reconnect) when the connection did not opt in", async () => {
    const tabId = makeSshTab(false);
    useAppStore.getState().setTerminalExited(tabId, { code: null, reason: "dropped" });
    await flush();

    const kinds = reconnectKinds(fake, tabId);
    expect(kinds).toContain("session.dropped");
    expect(kinds).not.toContain("session.reconnect");
    // The standard disconnect overlay path still applies.
    expect(useAppStore.getState().terminalExitedTabs[tabId]).toBe(true);
  });

  it("does NOT reconnect on a clean exit or a user kill", async () => {
    const cleanTab = makeSshTab(true);
    useAppStore.getState().setTerminalExited(cleanTab, { code: 0, reason: "clean" });
    const killedTab = makeSshTab(true);
    useAppStore.getState().setTerminalExited(killedTab, { code: null, reason: "killed" });
    await flush();

    expect(reconnectKinds(fake, cleanTab)).not.toContain("session.reconnect");
    // A clean exit mirrors nothing; a user kill is a graceful disconnect.
    expect(reconnectKinds(fake, killedTab)).not.toContain("session.reconnect");
    expect(reconnectKinds(fake, killedTab)).toContain("session.disconnect");
  });

  it("re-drives the tab when the backend timer projects Waiting→Connecting", async () => {
    const tabId = makeSshTab(true);
    useAppStore.getState().setTerminalExited(tabId, { code: null, reason: "dropped" });
    await flush();
    const retryBefore = useAppStore.getState().terminalRetryCounters[tabId] ?? 0;

    fake.fireAttempt(tabId, 1);
    await flush();

    // The region observer re-drives the tab (bumps its retry counter) so the
    // Terminal effect re-runs and re-attaches to the fresh backend session id.
    expect(useAppStore.getState().terminalRetryCounters[tabId] ?? 0).toBe(retryBefore + 1);
  });

  it("cancel dispatches session.cancelReconnect and marks the tab exited", async () => {
    const tabId = makeSshTab(true);
    useAppStore.getState().setTerminalExited(tabId, { code: null, reason: "dropped" });
    await flush();
    expect(currentSessionView()[tabId]?.status).toBe("reconnecting");

    useAppStore.getState().cancelAutoReconnect(tabId);
    await flush();

    expect(reconnectKinds(fake, tabId)).toContain("session.cancelReconnect");
    expect(useAppStore.getState().terminalExitedTabs[tabId]).toBe(true);
  });

  it("cancel is a no-op when the region shows no active reconnect", async () => {
    const tabId = makeSshTab(true);
    expect(() => useAppStore.getState().cancelAutoReconnect(tabId)).not.toThrow();
    await flush();
    expect(reconnectKinds(fake, tabId)).not.toContain("session.cancelReconnect");
  });

  it("re-drop after settling re-arms the region reconnect", async () => {
    const tabId = makeSshTab(true);
    useAppStore.getState().setTerminalExited(tabId, { code: null, reason: "dropped" });
    await flush();
    // Settle (reconnect succeeded elsewhere) then drop again.
    useAppStore.getState().reconnectTerminal(tabId);
    useAppStore.getState().setTabSessionId(tabId, "sess-2");
    fake.dispatched.length = 0;
    useAppStore.getState().setTerminalExited(tabId, { code: null, reason: "dropped" });
    await flush();
    expect(reconnectKinds(fake, tabId)).toContain("session.reconnect");
  });
});

describe("appStore — on-reconnect command (#1978 / #2205 PR-B)", () => {
  let injected: Array<{ tabId: string; data: string }>;

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    // The on-reconnect command trigger is independent of the region mutation cut.
    // A fake transport keeps setTabSessionId's `session.connected` mirror inert
    // (accepted no-op) so this suite exercises only the on-reconnect command path.
    setSessionTransportForTest(new FakeTransport());
    injected = [];
    registerTerminalInputInjector((tabId, data) => {
      injected.push({ tabId, data });
      return Promise.resolve(true);
    });
  });

  afterEach(() => {
    stopSessionSubscription();
    setSessionTransportForTest(null);
    registerTerminalInputInjector(null);
  });

  /** Drive a resilient tab through a reconnect that succeeds (retry counter bumped,
   * then a fresh session id lands). */
  function reconnectSuccessfully(tabId: string, sessionId = "sess-2"): void {
    useAppStore.getState().reconnectTerminal(tabId); // bumps the retry counter
    useAppStore.getState().setTabSessionId(tabId, sessionId);
  }

  it("runs the configured command once after a successful reconnect", () => {
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

  it("does not run the command on the initial connect (retry counter at 0)", () => {
    const tabId = makeSshTab(true, null, "tmux attach");
    useAppStore.getState().setTabSessionId(tabId, "sess-1");
    expect(injected).toEqual([]);
  });

  it("does not run the command for a non-resilient tab", () => {
    const tabId = makeSshTab(false, "sess-1", "tmux attach");
    reconnectSuccessfully(tabId);
    expect(injected).toEqual([]);
  });

  it("does not run the command when the reconnect never succeeds", () => {
    const tabId = makeSshTab(true, "sess-1", "tmux attach");
    useAppStore.getState().reconnectTerminal(tabId);
    // No fresh session id lands → the command never fires.
    expect(injected).toEqual([]);
  });

  it("runs the command again on each subsequent successful reconnect", () => {
    const tabId = makeSshTab(true, "sess-1", "tmux attach");
    reconnectSuccessfully(tabId, "sess-2");
    reconnectSuccessfully(tabId, "sess-3");
    expect(injected).toEqual([
      { tabId, data: "tmux attach\n" },
      { tabId, data: "tmux attach\n" },
    ]);
  });

  it("exposes the command via onReconnectCommandForTabId for the overlay", async () => {
    const { onReconnectCommandForTabId } = await import("./appStore");
    const tabId = makeSshTab(true, "sess-1", "tmux attach");
    expect(onReconnectCommandForTabId(tabId)).toBe("tmux attach");
  });
});
