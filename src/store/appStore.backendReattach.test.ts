/**
 * appStore parity tests for the backend-reattach authority cut (#2454).
 *
 * When the default-off `sessionBackendReattach` flag is ON, the **backend**
 * reconnect redrive owns the attempt OUTCOME — it folds `connected` /
 * `reconnectFailed` at the source. The client must therefore NOT also mirror
 * those (the reconnect engine is non-idempotent: a double `failure` would
 * double-count the attempt and give up early). This suite pins that surgical cut:
 *
 *  - flag ON  → a failed attempt does NOT dispatch `session.reconnectFailed`,
 *    but the local loop record still settles (the overlay is unaffected), and
 *    `drop` (`session.reconnect`) + user `cancel` (`session.cancelReconnect`)
 *    stay client-driven (the backend cannot observe those otherwise).
 *  - flag OFF → develop parity: a failed attempt DOES dispatch
 *    `session.reconnectFailed` exactly as before.
 *
 * The `sessionIntents` cut stays on throughout (its default), so only the new
 * `sessionBackendReattach` flag differs between the two cases.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushMacrotask as flush } from "@/test/flushAsync";

// The loop never calls the backend directly; these mocks only satisfy imports
// (mirrors appStore.sessionBridge.test.ts).
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
  setSessionBackendReattachEnabled,
  setSessionIntentsEnabled,
  setSessionTransportForTest,
  stopSessionSubscription,
  type ProjectedSessionLifecycle,
} from "./sessionBridge";

/** A transport double that records every dispatched intent and can project a
 * Waiting→Connecting edge, so the appStore mirror + reconcile round-trip runs. */
class RecordingTransport implements Transport {
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

  kinds(): string[] {
    return this.dispatched.map((i) => i.kind);
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

/** Drive a resilient tab into a connecting reconnect attempt, then fail it. */
async function dropAttemptThenFail(fake: RecordingTransport): Promise<string> {
  const tabId = makeSshTab();
  useAppStore.getState().setTerminalExited(tabId, { code: null, reason: "dropped" });
  await flush(); // subscription established; projected = waiting
  fake.fireAttempt(tabId, 1);
  await flush(); // ensureSessionReconcileWired → local attempt (connecting)
  expect(auto(tabId)?.phase).toBe("connecting");
  // A failed connect attempt while the loop is connecting drives "failure".
  useAppStore.getState().setTerminalSpawnError(tabId, "connection refused");
  await flush();
  return tabId;
}

describe("appStore — backend-reattach outcome-mirror suppression (#2454)", () => {
  let fake: RecordingTransport;

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    fake = new RecordingTransport();
    setSessionTransportForTest(fake);
    setSessionIntentsEnabled(true); // the underlying cut stays on (its default)
  });

  afterEach(() => {
    stopSessionSubscription();
    setSessionTransportForTest(null);
    setSessionIntentsEnabled(null);
    setSessionBackendReattachEnabled(null);
  });

  it("flag ON: a failed attempt does NOT dispatch session.reconnectFailed (backend owns it)", async () => {
    setSessionBackendReattachEnabled(true);
    const tabId = await dropAttemptThenFail(fake);

    expect(fake.kinds()).not.toContain("session.reconnectFailed");
    // The local loop still settles for the overlay — the record moved off
    // "connecting" (backed off to waiting or gave up), proving suppression is
    // scoped to the intent mirror, not the local state machine.
    expect(auto(tabId)?.phase).not.toBe("connecting");
  });

  it("flag OFF: a failed attempt DOES dispatch session.reconnectFailed (develop parity)", async () => {
    setSessionBackendReattachEnabled(false);
    await dropAttemptThenFail(fake);

    expect(fake.kinds()).toContain("session.reconnectFailed");
  });

  it("flag ON: drop still mirrors session.reconnect and user cancel still mirrors session.cancelReconnect", async () => {
    setSessionBackendReattachEnabled(true);
    const tabId = makeSshTab();
    useAppStore.getState().setTerminalExited(tabId, { code: null, reason: "dropped" });
    await flush();
    expect(fake.kinds()).toContain("session.reconnect");

    // A user cancel is client-originated — the backend cannot observe it
    // otherwise, so it must still reach `session.cancelReconnect`.
    useAppStore.getState().cancelAutoReconnect(tabId, "stopped by user");
    await flush();
    expect(fake.kinds()).toContain("session.cancelReconnect");
  });
});
