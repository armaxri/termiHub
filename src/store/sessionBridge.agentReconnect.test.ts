/**
 * Unit tests for {@link waitForBackendAgentReconnectOutcome} — the give-up-aware
 * wait that activates the backend-driven **agent** reconnect (#2476).
 *
 * Unlike {@link waitForBackendReattachSessionId} (direct SSH, #2457), this wait
 * has no short fall-through timeout: it stays deferred to the backend park/retry
 * loop for as long as the loop is active (a prolonged agent drop), resolving only
 * on a genuine terminal outcome — a fresh backend session id (reattach), an
 * exhausted-retry give-up, a server-side stop, or the effect being torn down.
 * That is what keeps the client from ever double-driving the agent transport the
 * backend redrive is re-establishing.
 *
 * The region is driven by an in-memory transport double so the round-trip runs
 * without a backend (mirrors sessionBridge.backendReattach.test.ts).
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
  waitForBackendAgentReconnectOutcome,
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

const reconnecting = (): ProjectedSessionLifecycle => ({
  status: "reconnecting",
  reconnect: { phase: "connecting", attempt: 1, delayMs: 0 },
});

const gaveUp = (error?: string): ProjectedSessionLifecycle => ({
  status: "failed",
  reconnect: { phase: "gaveup", attempt: 3, delayMs: 0 },
  error,
});

const lost = (error?: string): ProjectedSessionLifecycle => ({
  status: "sessionLost",
  reconnect: { phase: "idle", attempt: 0, delayMs: 0 },
  endReason: "unexpected",
  error,
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

describe("waitForBackendAgentReconnectOutcome", () => {
  const never = () => false;

  it("reattaches to a fresh backend session id (fast path)", async () => {
    transport.setSession("tab-1", connectedWith("agent-new"));
    await flush();
    const outcome = await waitForBackendAgentReconnectOutcome("tab-1", "agent-old", never);
    expect(outcome).toEqual({ kind: "reattach", sessionId: "agent-new" });
  });

  it("reattaches once the redrive publishes the id after the wait starts", async () => {
    const pending = waitForBackendAgentReconnectOutcome("tab-2", "agent-old", never);
    await flush();
    transport.setSession("tab-2", reconnecting()); // still parking — not terminal
    await flush();
    transport.setSession("tab-2", connectedWith("agent-fresh"));
    expect(await pending).toEqual({ kind: "reattach", sessionId: "agent-fresh" });
  });

  it("excludes the prior (dead) session id so it never re-attaches to a corpse", async () => {
    transport.setSession("tab-3", connectedWith("agent-old"));
    await flush();
    const pending = waitForBackendAgentReconnectOutcome("tab-3", "agent-old", never);
    await flush();
    transport.setSession("tab-3", connectedWith("agent-new"));
    expect(await pending).toEqual({ kind: "reattach", sessionId: "agent-new" });
  });

  it("gives up when the backend exhausts retries (reconnect.phase gaveup / status failed)", async () => {
    const pending = waitForBackendAgentReconnectOutcome("tab-4", "agent-old", never);
    await flush();
    transport.setSession("tab-4", reconnecting()); // parking — no resolution yet
    await flush();
    transport.setSession("tab-4", gaveUp("agent unreachable after 3 attempts"));
    expect(await pending).toEqual({
      kind: "giveup",
      error: "agent unreachable after 3 attempts",
    });
  });

  it("gives up (no error) when the loop is stopped server-side (status disconnected)", async () => {
    const pending = waitForBackendAgentReconnectOutcome("tab-5", "agent-old", never);
    await flush();
    transport.setSession("tab-5", {
      status: "disconnected",
      reconnect: { phase: "idle", attempt: 0, delayMs: 0 },
    });
    expect(await pending).toEqual({ kind: "giveup" });
  });

  it("does NOT resolve while the backend is still parking (no fall-through timeout)", async () => {
    let resolved: unknown = "pending";
    const pending = waitForBackendAgentReconnectOutcome("tab-6", "agent-old", never).then((o) => {
      resolved = o;
      return o;
    });
    await flush();
    transport.setSession("tab-6", reconnecting());
    // Give any (nonexistent) short timeout ample room to fire — it must not.
    await new Promise((r) => setTimeout(r, 60));
    expect(resolved).toBe("pending");
    // It still resolves once the backend reaches a terminal state.
    transport.setSession("tab-6", connectedWith("agent-late"));
    expect(await pending).toEqual({ kind: "reattach", sessionId: "agent-late" });
  });

  it("resolves canceled when the effect is torn down", async () => {
    const outcome = await waitForBackendAgentReconnectOutcome("tab-7", null, () => true);
    expect(outcome).toEqual({ kind: "canceled" });
  });

  it("reports session-lost when the live agent session is unrecoverable (#2512)", async () => {
    const pending = waitForBackendAgentReconnectOutcome("tab-8", "agent-old", never);
    await flush();
    transport.setSession("tab-8", reconnecting()); // parking — no resolution yet
    await flush();
    transport.setSession("tab-8", lost("the live agent session could not be recovered"));
    expect(await pending).toEqual({
      kind: "sessionLost",
      error: "the live agent session could not be recovered",
    });
  });

  it("reports session-lost with no error when the region carries none (#2512)", async () => {
    transport.setSession("tab-9", lost());
    await flush();
    const outcome = await waitForBackendAgentReconnectOutcome("tab-9", "agent-old", never);
    expect(outcome).toEqual({ kind: "sessionLost", error: undefined });
  });
});
