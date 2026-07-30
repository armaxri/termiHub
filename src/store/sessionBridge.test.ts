import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  FrameHandler,
  Intent,
  IntentAck,
  ProjectionFrame,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";
import type { TerminalAutoReconnectState } from "@/types/terminal";
import {
  DEFAULT_BACKOFF,
  initialReconnectState,
  nextReconnectDelay,
  reconnectReducer,
  type ReconnectState,
} from "@/utils/reconnectBackoff";

import {
  dispatchSessionIntent,
  mirrorSessionIntent,
  onSessionView,
  projectedToAutoReconnect,
  runSessionIntent,
  SESSION_LIFECYCLE_REGION,
  sessionIntentsEnabled,
  setSessionIntentsEnabled,
  setSessionTransportForTest,
  stopSessionSubscription,
  type ProjectedSessionLifecycle,
} from "./sessionBridge";

/**
 * An in-memory substrate double (reuses the #2164 harness idea): it records
 * dispatched intents, holds one `session-lifecycle` view, and fans a fresh
 * snapshot to every subscriber on each mutation, so multi-subscriber fan-out and
 * the reconcile round-trip are exercised without a backend.
 */
class FakeTransport implements Transport {
  dispatched: Intent[] = [];
  private view: { sessions: Record<string, ProjectedSessionLifecycle> } = { sessions: {} };
  private version = 0;
  private handlers: FrameHandler[] = [];
  /** When set, an intent applies this mutation to the view before acking. */
  onDispatch?: (intent: Intent, sessions: Record<string, ProjectedSessionLifecycle>) => void;

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    if (this.onDispatch) {
      this.onDispatch(intent, this.view.sessions);
      this.version += 1;
      this.fan();
      return {
        intentId: intent.intentId,
        status: "accepted",
        produced: [{ region: SESSION_LIFECYCLE_REGION, version: this.version }],
      };
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

  /** Directly set a session's projected lifecycle and fan the snapshot out. */
  setSession(id: string, life: ProjectedSessionLifecycle): void {
    this.view.sessions[id] = life;
    this.version += 1;
    this.fan();
  }

  private snapshot(region: string): SnapshotFrame {
    return {
      kind: "snapshot",
      region,
      version: this.version,
      view: structuredClone(this.view),
    };
  }

  private fan(): void {
    const frame: ProjectionFrame = this.snapshot(SESSION_LIFECYCLE_REGION);
    for (const h of this.handlers) h(frame);
  }
}

let transport: FakeTransport;

beforeEach(() => {
  transport = new FakeTransport();
  setSessionTransportForTest(transport);
  setSessionIntentsEnabled(null);
});

afterEach(() => {
  stopSessionSubscription();
  setSessionTransportForTest(null);
  setSessionIntentsEnabled(null);
});

describe("sessionIntentsEnabled flag", () => {
  it("defaults off and honours the programmatic override", () => {
    expect(sessionIntentsEnabled()).toBe(false);
    setSessionIntentsEnabled(true);
    expect(sessionIntentsEnabled()).toBe(true);
    setSessionIntentsEnabled(false);
    expect(sessionIntentsEnabled()).toBe(false);
    setSessionIntentsEnabled(null);
    expect(sessionIntentsEnabled()).toBe(false);
  });
});

describe("dispatchSessionIntent", () => {
  it("shapes the payload with the session id and optional error", async () => {
    await dispatchSessionIntent("session.reconnectFailed", "tab-1", "still down");
    await dispatchSessionIntent("session.connect", "tab-2");
    expect(transport.dispatched).toHaveLength(2);
    expect(transport.dispatched[0]).toMatchObject({
      kind: "session.reconnectFailed",
      payload: { sessionId: "tab-1", error: "still down" },
    });
    expect(transport.dispatched[1]).toMatchObject({
      kind: "session.connect",
      payload: { sessionId: "tab-2" },
    });
    expect(transport.dispatched[1].payload).not.toHaveProperty("error");
  });

  it("mirrorSessionIntent swallows a rejected ack without throwing", async () => {
    transport.onDispatch = () => {
      throw new Error("boom");
    };
    // Must not reject — the local path is the resilience fallback.
    expect(() => mirrorSessionIntent("session.connect", "tab-x")).not.toThrow();
    // Let the swallowed promise settle.
    await Promise.resolve();
  });
});

describe("projectedToAutoReconnect — cut-vs-local parity", () => {
  const maxAttempts = DEFAULT_BACKOFF.maxAttempts;

  /** The exact `terminalAutoReconnect` record `appStore.driveAutoReconnect`
   * builds locally for a reducer result, so the mapping is asserted equal. */
  function localRecord(
    next: ReconnectState,
    now: number,
    cmd?: string
  ): TerminalAutoReconnectState | null {
    const extra = cmd ? { onReconnectCommand: cmd } : {};
    if (next.phase === "waiting") {
      return {
        phase: "waiting",
        attempt: next.attempt,
        maxAttempts,
        delayMs: next.delayMs,
        nextAttemptAt: now + next.delayMs,
        ...extra,
      };
    }
    if (next.phase === "connecting") {
      return {
        phase: "connecting",
        attempt: next.attempt,
        maxAttempts,
        delayMs: 0,
        nextAttemptAt: 0,
        ...extra,
      };
    }
    return null;
  }

  function projectedFrom(state: ReconnectState): ProjectedSessionLifecycle {
    return {
      status: "reconnecting",
      reconnect: { phase: state.phase, attempt: state.attempt, delayMs: state.delayMs },
    };
  }

  it("reproduces the local record for waiting and connecting phases", () => {
    const now = 1_000_000;
    const rand = () => 0.5; // zero jitter → exact delays
    // drop → waiting (attempt 0, delay for attempt 1)
    const waiting = reconnectReducer(initialReconnectState, "drop", DEFAULT_BACKOFF, rand);
    expect(projectedToAutoReconnect(projectedFrom(waiting), now, "tmux attach")).toEqual(
      localRecord(waiting, now, "tmux attach")
    );
    // attempt → connecting (attempt 1)
    const connecting = reconnectReducer(waiting, "attempt", DEFAULT_BACKOFF, rand);
    expect(projectedToAutoReconnect(projectedFrom(connecting), now)).toEqual(
      localRecord(connecting, now)
    );
    // failure → waiting again (attempt 1, delay for attempt 2)
    const waiting2 = reconnectReducer(connecting, "failure", DEFAULT_BACKOFF, rand);
    expect(waiting2.delayMs).toBe(nextReconnectDelay(waiting2.attempt + 1, DEFAULT_BACKOFF, rand));
    expect(projectedToAutoReconnect(projectedFrom(waiting2), now)).toEqual(
      localRecord(waiting2, now)
    );
  });

  it("maps idle / connected / gaveup to no active record", () => {
    const now = 42;
    for (const phase of ["idle", "connected", "gaveup"] as const) {
      expect(
        projectedToAutoReconnect(
          { status: "disconnected", reconnect: { phase, attempt: 3, delayMs: 0 } },
          now
        )
      ).toBeNull();
    }
  });
});

describe("shared region reconcile fan-out", () => {
  it("delivers each projected diff to every onSessionView subscriber", async () => {
    const seenA: Record<string, ProjectedSessionLifecycle>[] = [];
    const seenB: Record<string, ProjectedSessionLifecycle>[] = [];
    onSessionView((next) => seenA.push(structuredClone(next)));
    onSessionView((next) => seenB.push(structuredClone(next)));

    // Import triggers the subscription lazily; force it via runSessionIntent's
    // ensure path by directly subscribing through a mirrored intent + push.
    const { ensureSessionSubscribed } = await import("./sessionBridge");
    await ensureSessionSubscribed();

    transport.setSession("tab-1", {
      status: "reconnecting",
      reconnect: { phase: "waiting", attempt: 0, delayMs: 1000 },
    });
    transport.setSession("tab-1", {
      status: "connected",
      reconnect: { phase: "idle", attempt: 0, delayMs: 0 },
    });

    // Both subscribers observed both transitions (plus the initial empty snapshot).
    const lastA = seenA[seenA.length - 1];
    const lastB = seenB[seenB.length - 1];
    expect(lastA["tab-1"].status).toBe("connected");
    expect(lastB["tab-1"].status).toBe("connected");
    expect(seenA).toEqual(seenB);
  });
});

describe("runSessionIntent", () => {
  it("dispatches and resolves with the projected lifecycle after the version lands", async () => {
    transport.onDispatch = (intent, sessions) => {
      const id = (intent.payload as { sessionId: string }).sessionId;
      sessions[id] = {
        status: "connecting",
        reconnect: { phase: "idle", attempt: 0, delayMs: 0 },
      };
    };
    const life = await runSessionIntent("session.connect", "tab-9");
    expect(life).toEqual({
      status: "connecting",
      reconnect: { phase: "idle", attempt: 0, delayMs: 0 },
    });
  });

  it("throws on a rejected intent so the caller can fall back locally", async () => {
    setSessionTransportForTest({
      dispatch: async (intent: Intent) => ({
        intentId: intent.intentId,
        status: "rejected" as const,
        error: { code: "bad_payload", message: "nope" },
      }),
      subscribe: async (region: string, onFrame: FrameHandler) => {
        void onFrame;
        return {
          snapshot: { kind: "snapshot", region, version: 0, view: { sessions: {} } },
          unsubscribe: () => {},
        };
      },
      resync: async () => null,
    });
    await expect(runSessionIntent("session.connect", "tab-z")).rejects.toThrow(/nope/);
  });
});
