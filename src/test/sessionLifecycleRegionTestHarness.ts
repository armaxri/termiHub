/**
 * Test harness for the projected `session-lifecycle` region (#2205 PR-A render
 * cut, part of #2152 / #2139).
 *
 * The terminal lifecycle readers — the connection / disconnect overlays, the
 * tab-strip status dot, the split-panel overlay gates and Open Connections — source
 * their connect / reconnect / disconnect status from the shared `session-lifecycle`
 * region via {@link import("@/store/useSessionLifecycle").useProjectedSessionLifecycle}
 * / {@link import("@/store/useSessionLifecycle").useProjectedSessionLifecycleMaps},
 * under a faithful-mirror gate with an `appStore` fallback. This harness lets a test
 * drive that region without a backend.
 *
 * It generalises the in-memory region double first written inline in
 * `TerminalDisconnectOverlay.projection.test.tsx` (#2204): {@link FakeSessionTransport}
 * holds one `{ sessions }` view and fans a fresh snapshot to every subscriber on
 * each mutation. {@link installSessionLifecycleHarness} wires it (plus the render /
 * intent flags) into a `beforeEach` / `afterEach` pair and hands back a small handle
 * for seeding sessions. The `connecting` / `reconnecting` / `disconnected` /
 * `connected` builders produce the twin serde shapes the Rust `SessionLifecycleStore`
 * serialises.
 *
 * PR-A is a render cut: `appStore` is still the authoritative writer, so a component
 * test typically seeds *both* — `appStore` for the authoritative slice the gate
 * compares against, and the region for the value the render should source. Seeding
 * only `appStore` (region empty) is the fallback path and stays byte-identical.
 */

import { afterEach, beforeEach } from "vitest";
import { act } from "react";

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
  setSessionIntentsEnabled,
  setSessionRenderFromProjectionEnabled,
  setSessionTransportForTest,
  stopSessionSubscription,
  type ProjectedReconnect,
  type ProjectedEndReason,
  type ProjectedSessionLifecycle,
} from "@/store/sessionBridge";

/**
 * An in-memory `session-lifecycle` region double: holds one view and fans a fresh
 * snapshot to every subscriber on each mutation, so a reader's render can be driven
 * by projected snapshots without a backend. Intents are accepted as no-ops (PR-A
 * changes reads, not writes — the authoritative slice lives in `appStore`).
 */
export class FakeSessionTransport implements Transport {
  private view: { sessions: Record<string, ProjectedSessionLifecycle> } = { sessions: {} };
  private version = 0;
  private handlers: FrameHandler[] = [];
  /** How many times a client subscribed — asserts the region was actually read. */
  subscribeCount = 0;

  async dispatch(intent: Intent): Promise<IntentAck> {
    return { intentId: intent.intentId, status: "accepted", produced: [] };
  }

  async subscribe(region: string, onFrame: FrameHandler): Promise<Subscription> {
    this.subscribeCount += 1;
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

  /** Remove a session from the projected view and fan the fresh snapshot out. */
  clearSession(id: string): void {
    delete this.view.sessions[id];
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

/** A handle onto the installed harness for seeding the region within a test. */
export interface SessionLifecycleHarness {
  /** The live region double; use {@link FakeSessionTransport.setSession}. */
  transport: FakeSessionTransport;
}

/**
 * Install the `session-lifecycle` region double for a test suite: wire the fake
 * transport and turn the render / intent flags on in `beforeEach`, and tear the
 * subscription / transport / flag overrides down in `afterEach`. Returns a handle
 * whose `transport` is refreshed for each test.
 *
 * @param renderFromProjection Whether the render cut is on (default `true`). Pass
 *   `false` to exercise the flag-off fallback path.
 */
export function installSessionLifecycleHarness(
  renderFromProjection = true
): SessionLifecycleHarness {
  const handle: SessionLifecycleHarness = { transport: new FakeSessionTransport() };

  beforeEach(() => {
    handle.transport = new FakeSessionTransport();
    setSessionTransportForTest(handle.transport);
    setSessionRenderFromProjectionEnabled(renderFromProjection);
    setSessionIntentsEnabled(true);
  });

  afterEach(() => {
    stopSessionSubscription();
    setSessionTransportForTest(null);
    setSessionRenderFromProjectionEnabled(null);
    setSessionIntentsEnabled(null);
  });

  return handle;
}

/** Flush the bridge's async subscribe + fan-out so a projected snapshot lands. */
export async function flushSessionRegion(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ── Projected-lifecycle builders (twins of the Rust serde shapes) ───────────────

/** A `connecting` (initial connect in flight) projected lifecycle. */
export function connecting(): ProjectedSessionLifecycle {
  return { status: "connecting", reconnect: idleReconnect() };
}

/** A `connected` projected lifecycle. */
export function connected(): ProjectedSessionLifecycle {
  return { status: "connected", reconnect: idleReconnect() };
}

/** A `reconnecting` projected lifecycle carrying the loop detail. */
export function reconnecting(reconnect: ProjectedReconnect): ProjectedSessionLifecycle {
  return { status: "reconnecting", reconnect };
}

/** A terminal `failed` projected lifecycle carrying the disconnect error. */
export function failed(error: string, endReason: ProjectedEndReason = "error"): ProjectedSessionLifecycle {
  return { status: "failed", reconnect: idleReconnect(), endReason, error };
}

/** The idle reconnect detail (no loop active). */
export function idleReconnect(): ProjectedReconnect {
  return { phase: "idle", attempt: 0, delayMs: 0 };
}
