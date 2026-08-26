/**
 * Unit tests for the backend-driven re-attach bridge surface (#2457, part of the
 * server-side reconnect redrive #2454 / umbrella #2446).
 *
 * Covers {@link waitForBackendReattachSessionId} — resolves the backend session id
 * the server-side redrive publishes to the `session-lifecycle` region (keyed by tab
 * id), so the terminal can re-attach I/O without calling `create_connection`.
 *
 * The region is driven by an in-memory transport double so the round-trip is
 * exercised without a backend.
 */

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
import {
  SESSION_LIFECYCLE_REGION,
  setSessionTransportForTest,
  stopSessionSubscription,
  waitForBackendReattachSessionId,
  type ProjectedSessionLifecycle,
} from "./sessionBridge";

/** An in-memory `session-lifecycle` region double that fans a fresh snapshot to
 * every subscriber on each mutation. */
class FakeTransport implements Transport {
  private view: { sessions: Record<string, ProjectedSessionLifecycle> } = { sessions: {} };
  private version = 0;
  private handlers: FrameHandler[] = [];

  async dispatch(intent: Intent): Promise<IntentAck> {
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

  /** Set a session's projected lifecycle and fan the fresh snapshot out. */
  setSession(id: string, life: ProjectedSessionLifecycle): void {
    this.view.sessions[id] = life;
    this.version += 1;
    this.fan();
  }

  private snapshot(region: string): SnapshotFrame {
    return { kind: "snapshot", region, version: this.version, view: structuredClone(this.view) };
  }

  private fan(): void {
    const frame: ProjectionFrame = this.snapshot(SESSION_LIFECYCLE_REGION);
    for (const h of this.handlers) h(frame);
  }
}

const connectedWith = (sessionId: string): ProjectedSessionLifecycle => ({
  status: "connected",
  reconnect: { phase: "idle", attempt: 0, delayMs: 0 },
  sessionId,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

let transport: FakeTransport;

beforeEach(() => {
  transport = new FakeTransport();
  setSessionTransportForTest(transport);
});

afterEach(() => {
  stopSessionSubscription();
  setSessionTransportForTest(null);
});

describe("waitForBackendReattachSessionId", () => {
  const never = () => false;

  it("resolves with the id already present in the region (fast path)", async () => {
    // The redrive already published the new backend id before the terminal waits.
    transport.setSession("tab-1", connectedWith("backend-new"));
    await flush(); // let the initial snapshot land in the last-known view

    const id = await waitForBackendReattachSessionId("tab-1", "backend-old", never);
    expect(id).toBe("backend-new");
  });

  it("resolves once the region publishes the id after the wait starts", async () => {
    const pending = waitForBackendReattachSessionId("tab-2", "backend-old", never);
    await flush();
    // The server-side redrive publishes the fresh id via a later diff.
    transport.setSession("tab-2", connectedWith("backend-fresh"));
    expect(await pending).toBe("backend-fresh");
  });

  it("excludes the prior (dead) session id so it never re-attaches to a corpse", async () => {
    // A stale region value equal to the dead id must not resolve the wait.
    transport.setSession("tab-3", connectedWith("backend-old"));
    await flush();

    const pending = waitForBackendReattachSessionId("tab-3", "backend-old", never, 60);
    await flush();
    // Only the genuinely new id resolves it.
    transport.setSession("tab-3", connectedWith("backend-new"));
    expect(await pending).toBe("backend-new");
  });

  it("resolves null when the effect is cancelled", async () => {
    const id = await waitForBackendReattachSessionId("tab-4", null, () => true);
    expect(id).toBeNull();
  });

  it("resolves null after the timeout when no id is published", async () => {
    const id = await waitForBackendReattachSessionId("tab-5", null, never, 20);
    expect(id).toBeNull();
  });
});
