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
  currentSessionView,
  dispatchSessionIntent,
  effectiveAutoReconnect,
  effectiveExited,
  effectiveExitedMap,
  effectiveReconnectingMap,
  ensureSessionSubscribed,
  mirrorSessionExited,
  mirrorSessionIntent,
  onSessionView,
  projectedToAutoReconnect,
  regionExited,
  runSessionIntent,
  SESSION_LIFECYCLE_REGION,
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
});

afterEach(() => {
  stopSessionSubscription();
  setSessionTransportForTest(null);
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

describe("effectiveAutoReconnect — purely region-sourced (#2205 PR-B)", () => {
  const waiting: ProjectedSessionLifecycle = {
    status: "reconnecting",
    reconnect: { phase: "waiting", attempt: 2, delayMs: 4_000 },
  };

  it("returns undefined when the region has no active loop", () => {
    expect(effectiveAutoReconnect(undefined, 1_000_000)).toBeUndefined();
    // connected / idle / gaveup all map to no loop record.
    expect(
      effectiveAutoReconnect({ status: "connected", reconnect: initialReconnectState }, 1_000_000)
    ).toBeUndefined();
  });

  it("builds the record from the region, anchoring the countdown at the given now", () => {
    const record = effectiveAutoReconnect(waiting, 1_000_000, "tmux attach");
    expect(record).toEqual({
      phase: "waiting",
      attempt: 2,
      maxAttempts: DEFAULT_BACKOFF.maxAttempts,
      delayMs: 4_000,
      nextAttemptAt: 1_004_000,
      onReconnectCommand: "tmux attach",
    });
  });

  it("uses the caller-supplied anchor verbatim (the hook fixes it per attempt)", () => {
    const a = effectiveAutoReconnect(waiting, 5_000_000);
    const b = effectiveAutoReconnect(waiting, 9_999_999);
    // Same projected loop, different anchors ⇒ different fixed deadlines.
    expect(a?.nextAttemptAt).toBe(5_004_000);
    expect(b?.nextAttemptAt).toBe(9_999_999 + 4_000);
  });
});

describe("optimistic client-side folding (#2533)", () => {
  const connecting: ProjectedSessionLifecycle = {
    status: "connecting",
    reconnect: initialReconnectState,
  };

  /** Let the dispatch + reconcile microtasks settle. */
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));

  it("applies session.connect optimistically so the connecting state is gap-free — synchronously, before any await", () => {
    // The backend also records the connect (realistic path), but the assertion
    // fires synchronously, before the dispatch promise resolves: the overlay
    // alone makes the projection connecting, so there is NO local write needed.
    transport.onDispatch = (intent, sessions) => {
      const id = (intent.payload as { sessionId: string }).sessionId;
      sessions[id] = { status: "connecting", reconnect: initialReconnectState };
    };

    const seen: Array<Record<string, ProjectedSessionLifecycle>> = [];
    onSessionView((next) => seen.push(structuredClone(next)));

    mirrorSessionIntent("session.connect", "tab-1");

    // Gap-free: the projected read reflects the intent immediately.
    expect(currentSessionView()["tab-1"]).toEqual(connecting);
    expect(seen[seen.length - 1]?.["tab-1"]).toEqual(connecting);
    expect(transport.dispatched).toHaveLength(1);
    expect(transport.dispatched[0].kind).toBe("session.connect");
  });

  it("reconciles the overlay against the authoritative diff (no double-apply, overlay pruned)", async () => {
    transport.onDispatch = (intent, sessions) => {
      const id = (intent.payload as { sessionId: string }).sessionId;
      sessions[id] = { status: "connecting", reconnect: initialReconnectState };
    };

    mirrorSessionIntent("session.connect", "tab-1");
    expect(currentSessionView()["tab-1"]).toEqual(connecting);

    await flush();

    // Still connecting — but now sourced from the authoritative view, with the
    // overlay pruned (the value is exactly the backend's, not folded twice).
    expect(currentSessionView()["tab-1"]).toEqual(connecting);
    // A later authoritative transition wins with no stale optimistic residue.
    transport.setSession("tab-1", { status: "connected", reconnect: initialReconnectState });
    await flush();
    expect(currentSessionView()["tab-1"]).toEqual({
      status: "connected",
      reconnect: initialReconnectState,
    });
  });

  it("rolls the overlay back cleanly when the intent diverges (backend produced no change)", async () => {
    // No onDispatch ⇒ the fake acks `accepted` with an empty `produced`: nothing
    // authoritative will confirm the overlay, so it must be rolled back.
    await ensureSessionSubscribed();

    mirrorSessionIntent("session.connect", "tab-1");
    // Synchronously overlaid…
    expect(currentSessionView()["tab-1"]).toEqual(connecting);

    await flush();

    // …then rolled back to the authoritative (empty) view — never stranded.
    expect(currentSessionView()["tab-1"]).toBeUndefined();
  });

  it("does not overlay non-folded intents (minimal blast radius)", () => {
    // `session.cancelReconnect` has no registered fold, so it dispatches without any
    // synchronous overlay: the projected view is untouched for an unknown tab.
    // (The exit intents `disconnect` / `dropped` / `connectFailed` DO fold now, #2621.)
    mirrorSessionIntent("session.cancelReconnect", "tab-x");
    expect(currentSessionView()["tab-x"]).toBeUndefined();
    expect(transport.dispatched[transport.dispatched.length - 1]?.kind).toBe(
      "session.cancelReconnect"
    );
  });

  it("effectiveReconnectingMap picks up a transient-break shape so the tab-strip dot shows connecting (#2555)", () => {
    // The tab-strip status dot derives `reconnecting` from `effectiveReconnectingMap`
    // (status-only, phase-agnostic). A transient agent-break folds `reconnecting`
    // with an idle loop — assert the map recognises it so the dot leaves green
    // during the break (the #2554 dot regression, twin of the overlay one).
    const map = effectiveReconnectingMap({
      "tab-1": { status: "reconnecting", reconnect: initialReconnectState },
      "tab-2": { status: "connected", reconnect: initialReconnectState },
    });
    expect(map).toEqual({ "tab-1": true });
  });

  it("session.connected folds a reconnecting session back to connected (survived resolver, #2556)", async () => {
    // The transient-break reconnecting fold is now backend-owned (`agent_io_task`,
    // #2556) — no client `session.agentTransportReconnecting` intent — so this
    // seeds the reconnecting state via the authoritative diff and asserts the
    // `session.connected` resolver (the survived-recovery edge the backend folds)
    // clears it. The region is never left stuck reconnecting.
    transport.onDispatch = (intent, sessions) => {
      const id = (intent.payload as { sessionId: string }).sessionId;
      if (intent.kind === "session.connected") {
        sessions[id] = { status: "connected", reconnect: initialReconnectState };
      }
    };

    // The region subscription is lazy; establish it before seeding a snapshot.
    const { ensureSessionSubscribed } = await import("./sessionBridge");
    await ensureSessionSubscribed();

    // Seed the reconnecting state as the backend would publish it.
    transport.setSession("tab-1", { status: "reconnecting", reconnect: initialReconnectState });
    await flush();
    expect(currentSessionView()["tab-1"]?.status).toBe("reconnecting");

    // The survived-recovery resolver folds the same session back to connected.
    mirrorSessionIntent("session.connected", "tab-1");
    await flush();
    expect(currentSessionView()["tab-1"]).toEqual({
      status: "connected",
      reconnect: initialReconnectState,
    });
  });
});

describe("regionExited — the overlay mount-gate predicate (#2621)", () => {
  const life = (
    status: ProjectedSessionLifecycle["status"],
    extra = {}
  ): ProjectedSessionLifecycle => ({ status, reconnect: initialReconnectState, ...extra });

  it("is true for the terminal statuses and false for the live/reconnecting ones", () => {
    expect(regionExited(undefined)).toBe(false);
    expect(regionExited(life("connecting"))).toBe(false);
    expect(regionExited(life("connected"))).toBe(false);
    expect(regionExited(life("reconnecting"))).toBe(false);
    expect(regionExited(life("disconnected"))).toBe(true);
    expect(regionExited(life("failed"))).toBe(true);
    expect(regionExited(life("sessionLost"))).toBe(true);
  });

  it("is true for a clean exit that fired only `session.exited` (status still connected)", () => {
    // A clean process exit dispatches no status intent — the region keeps its live
    // status and records the end solely as `exit`, which is what marks it ended.
    expect(regionExited(life("connected", { exit: { reason: "clean", code: 0 } }))).toBe(true);
  });

  it("effectiveExited is the region-only mount gate (#2625)", () => {
    expect(effectiveExited(undefined)).toBe(false);
    expect(effectiveExited(life("failed"))).toBe(true);
    expect(effectiveExited(life("disconnected"))).toBe(true);
    expect(effectiveExited(life("connected", { exit: { reason: "clean", code: 0 } }))).toBe(true);
    expect(effectiveExited(life("reconnecting"))).toBe(false); // reconnecting is NOT exited
  });

  it("effectiveExitedMap collects the region-exited keys (#2625)", () => {
    const map = effectiveExitedMap({
      b: life("failed"),
      c: life("reconnecting"),
      d: life("connected", { exit: { reason: "dropped", code: null } }),
    });
    expect(map).toEqual({ b: true, d: true });
  });
});

describe("exit folds — synchronous mount-gate (#2621)", () => {
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));

  it("folds session.disconnect (killed) to disconnected synchronously, preserving a prior exit", () => {
    // A killed exit fires `session.exited` (metadata) then `session.disconnect`;
    // the disconnect fold must preserve the recorded exit so the overlay keeps its
    // killed wording, and flip the region-derived mount gate the same tick.
    mirrorSessionExited("tab-1", { reason: "killed", code: null });
    mirrorSessionIntent("session.disconnect", "tab-1");
    const life = currentSessionView()["tab-1"];
    expect(life?.status).toBe("disconnected");
    expect(life?.endReason).toBe("user");
    expect(life?.exit).toEqual({ reason: "killed", code: null });
    expect(regionExited(life)).toBe(true);
  });

  it("folds session.dropped (non-resilient) to disconnected with the error", () => {
    mirrorSessionIntent("session.dropped", "tab-2", "peer reset");
    const life = currentSessionView()["tab-2"];
    expect(life?.status).toBe("disconnected");
    expect(life?.endReason).toBe("unexpected");
    expect(life?.error).toBe("peer reset");
    expect(regionExited(life)).toBe(true);
  });

  it("folds session.connectFailed to failed with the error", () => {
    mirrorSessionIntent("session.connectFailed", "tab-3", "auth failed");
    const life = currentSessionView()["tab-3"];
    expect(life?.status).toBe("failed");
    expect(life?.error).toBe("auth failed");
    expect(regionExited(life)).toBe(true);
  });

  it("folds a clean session.exited synchronously (no status intent needed)", () => {
    // The gap-free crux: a clean exit only fires `session.exited`, so its optimistic
    // fold must record `exit` synchronously to flip the mount gate before the diff.
    mirrorSessionExited("tab-4", { reason: "clean", code: 0 });
    const life = currentSessionView()["tab-4"];
    expect(life?.exit).toEqual({ reason: "clean", code: 0 });
    expect(regionExited(life)).toBe(true);
    expect(transport.dispatched[transport.dispatched.length - 1]?.kind).toBe("session.exited");
  });

  it("reconciles the exit fold against the authoritative diff without a flip", async () => {
    // The backend records the same exit; after the diff lands the mount gate stays.
    transport.onDispatch = (intent, sessions) => {
      if (intent.kind !== "session.exited") return;
      const p = intent.payload as { sessionId: string; reason: string; code: number | null };
      sessions[p.sessionId] = {
        status: "connected",
        reconnect: initialReconnectState,
        exit: { reason: p.reason as "clean", code: p.code },
      };
    };
    mirrorSessionExited("tab-5", { reason: "clean", code: 0 });
    expect(regionExited(currentSessionView()["tab-5"])).toBe(true);
    await flush();
    expect(regionExited(currentSessionView()["tab-5"])).toBe(true);
  });
});
