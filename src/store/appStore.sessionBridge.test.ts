import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushMacrotask as flush } from "@/test/flushAsync";

// Same lightweight service mocks the auto-reconnect suite uses: the loop never
// calls the backend directly, so these only satisfy module import.
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
  reloadExternalConnections: vi.fn(() => Promise.resolve()),
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
import {
  SESSION_LIFECYCLE_REGION,
  setSessionIntentsEnabled,
  setSessionTransportForTest,
  stopSessionSubscription,
  type ProjectedSessionLifecycle,
} from "./sessionBridge";

/** A substrate double that applies `session.reconnect` (→ waiting) and fans a
 * fresh snapshot to every subscriber, so the appStore cut's mirror + reconcile
 * round-trip runs end to end. */
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
    return { intentId: intent.intentId, status: "accepted", produced: [] };
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

const auto = (tabId: string) => useAppStore.getState().terminalAutoReconnect[tabId];

function makeSshTab(): string {
  return useAppStore.getState().addTab(
    "web01",
    "ssh",
    {
      type: "ssh",
      config: { host: "web01.example.com", username: "deploy", resilientReconnect: true },
    },
    { contentType: "terminal", sessionId: "sess-1" }
  );
}

describe("appStore — session-intents cut (#2203), flag on", () => {
  let fake: FakeTransport;

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    fake = new FakeTransport();
    setSessionTransportForTest(fake);
    setSessionIntentsEnabled(true);
  });

  afterEach(() => {
    stopSessionSubscription();
    setSessionTransportForTest(null);
    setSessionIntentsEnabled(null);
  });

  it("mirrors a dropped resilient tab as session.reconnect and arms no local timer", async () => {
    vi.useFakeTimers();
    const tabId = makeSshTab();
    useAppStore.getState().setTerminalExited(tabId, { code: null, reason: "dropped" });

    // The local render state still enters waiting (unchanged this step)…
    expect(auto(tabId).phase).toBe("waiting");
    // …but no local setTimeout was armed: advancing well past the backoff window
    // does NOT advance the loop — the backend timer owns that edge now.
    vi.advanceTimersByTime(60_000);
    expect(auto(tabId).phase).toBe("waiting");
    vi.useRealTimers();

    await flush();
    expect(
      fake.dispatched.some(
        (i) =>
          i.kind === "session.reconnect" && (i.payload as { sessionId: string }).sessionId === tabId
      )
    ).toBe(true);
  });

  it("drives the local attempt when the backend timer projects Waiting→Connecting", async () => {
    const tabId = makeSshTab();
    useAppStore.getState().setTerminalExited(tabId, { code: null, reason: "dropped" });
    await flush(); // subscription established; projected state = waiting

    fake.fireAttempt(tabId, 1);
    await flush();

    expect(auto(tabId).phase).toBe("connecting");
    expect(auto(tabId).attempt).toBe(1);
  });
});
