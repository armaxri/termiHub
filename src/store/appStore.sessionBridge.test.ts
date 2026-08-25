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
  currentSessionView,
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

  it("mirrors a dropped resilient tab as session.reconnect and folds the region to waiting", async () => {
    const tabId = makeSshTab();
    useAppStore.getState().setTerminalExited(tabId, { code: null, reason: "dropped" });

    await flush();
    // The drop is folded into the region as `session.reconnect` — the backend
    // redrive is the sole reconnect authority (#2205 PR-B); there is no local timer.
    expect(
      fake.dispatched.some(
        (i) =>
          i.kind === "session.reconnect" && (i.payload as { sessionId: string }).sessionId === tabId
      )
    ).toBe(true);
    expect(currentSessionView()[tabId]?.status).toBe("reconnecting");
    expect(currentSessionView()[tabId]?.reconnect.phase).toBe("waiting");
  });

  it("re-drives the tab when the backend timer projects Waiting→Connecting", async () => {
    const tabId = makeSshTab();
    useAppStore.getState().setTerminalExited(tabId, { code: null, reason: "dropped" });
    await flush(); // subscription established; projected state = waiting
    const retryBefore = useAppStore.getState().terminalRetryCounters[tabId] ?? 0;

    fake.fireAttempt(tabId, 1);
    await flush();

    // The region observer re-drives the tab so its Terminal effect re-runs and
    // re-attaches to the fresh backend session id (retry counter bumped).
    expect(useAppStore.getState().terminalRetryCounters[tabId] ?? 0).toBe(retryBefore + 1);
  });
});
