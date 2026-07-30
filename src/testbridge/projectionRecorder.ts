/**
 * In-app recorder for driving the projection substrate (#2149) from the test
 * bridge — the app-side half of the Python bridge harness (#2164).
 *
 * The projection substrate's diff frames ride a per-region Tauri IPC `Channel`
 * (see `src-tauri/src/commands/projection.rs`), so they never touch the DOM or
 * the Zustand store — the rest of the bridge's introspection verbs cannot see
 * them. This recorder subscribes to a region through the **real** production
 * transport ({@link createTransport} → `TauriTransport`) and the **real**
 * {@link ProjectionClient} cache, buffering every raw frame the channel pushes so
 * the synchronous Python harness can poll for them and assert the sequence.
 *
 * Two things make it a faithful end-to-end exercise rather than a mock:
 *
 * - Every frame flows through the same `TauriTransport` + `ProjectionClient` the
 *   app uses, over the real backend fan-out. The harness asserts the actual wire
 *   frames (`baseVersion`/`version`/`ops`) and the actual applied view.
 * - A **forced gap** is produced honestly: {@link Recording.dropRemaining} makes
 *   the recorder swallow the next delivered diff (a simulated lost/reordered
 *   frame) *before* it reaches the client. The next diff then arrives with a
 *   `baseVersion` ahead of the cache, and the production {@link ProjectionClient}
 *   detects the gap and re-baselines via a real `resync` — exactly the path a
 *   dropped frame triggers in production.
 *
 * Installed only in test-bridge mode; it never loads in a production launch.
 */

import {
  createTransport,
  ProjectionClient,
  newClientId,
  newIntentId,
} from "@/services/transport";
import type {
  FrameHandler,
  Intent,
  IntentAck,
  ProjectionCacheState,
  ProjectionFrame,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";

/** A dispatched-intent request from the harness; ids are filled in if omitted. */
export interface ProjectionDispatchRequest {
  kind: string;
  payload?: unknown;
  /** Client-generated ULID; a fresh one is minted when absent. */
  intentId?: string;
  /** Fan-out / audit identity; a fresh client id is minted when absent. */
  clientId?: string;
}

/** The observable state of one subscription, returned to the harness. */
export interface ProjectionRecordingState {
  subscriptionId: string;
  region: string;
  /** The snapshot adopted at attach, the cache's initial baseline. */
  snapshot: SnapshotFrame;
  /** Every raw frame the channel delivered, in order (diffs; snapshots on push). */
  frames: ProjectionFrame[];
  /** The production {@link ProjectionClient} cache after applying delivered frames. */
  cache: ProjectionCacheState;
  /** Frames still scheduled to be dropped before delivery (forced-gap control). */
  dropRemaining: number;
}

/** One live subscription: its recording buffer, drop control, and cache client. */
interface Recording {
  region: string;
  client: ProjectionClient;
  frames: ProjectionFrame[];
  dropRemaining: number;
  snapshot?: SnapshotFrame;
}

/**
 * A {@link Transport} wrapper that records every pushed frame and can drop a
 * scheduled count of diffs before they reach the wrapped subscriber.
 *
 * `dispatch` and `resync` pass straight through to the inner transport, so the
 * client's real gap-driven `resync` hits the real backend. Only `subscribe`'s
 * frame stream is interposed.
 */
class RecordingTransport implements Transport {
  constructor(
    private readonly inner: Transport,
    private readonly recording: Recording
  ) {}

  dispatch(intent: Intent): Promise<IntentAck> {
    return this.inner.dispatch(intent);
  }

  resync(region: string, have?: number): Promise<SnapshotFrame | null> {
    return this.inner.resync(region, have);
  }

  async subscribe(region: string, onFrame: FrameHandler): Promise<Subscription> {
    const subscription = await this.inner.subscribe(region, (frame) => {
      this.recording.frames.push(frame);
      if (this.recording.dropRemaining > 0) {
        // Simulate a lost/reordered frame: it is recorded (so the harness can
        // see it was produced) but withheld from the client, so the *next* diff
        // arrives with a baseVersion ahead of the cache and trips the real
        // gap → resync path.
        this.recording.dropRemaining -= 1;
        return;
      }
      onFrame(frame);
    });
    this.recording.snapshot = subscription.snapshot;
    return subscription;
  }
}

/**
 * Owns every harness subscription for the page and the shared transport used for
 * intent dispatch and resync. One instance per app page (see {@link TestBridge}).
 */
export class ProjectionRecorder {
  private readonly transport: Transport;
  private readonly recordings = new Map<string, Recording>();
  private counter = 0;

  /** `transport` is injectable for unit tests; defaults to the real transport. */
  constructor(transport?: Transport) {
    this.transport = transport ?? createTransport();
  }

  /** Attach to `region`; returns the new subscription id and its baseline state. */
  async subscribe(region: string): Promise<ProjectionRecordingState> {
    const subscriptionId = `harness:${region}:${this.counter++}`;
    const recording: Recording = {
      region,
      client: undefined as unknown as ProjectionClient,
      frames: [],
      dropRemaining: 0,
    };
    const client = new ProjectionClient(
      new RecordingTransport(this.transport, recording),
      region
    );
    recording.client = client;
    await client.start();
    this.recordings.set(subscriptionId, recording);
    return this.stateOf(subscriptionId, recording);
  }

  /** Dispatch an intent over the shared transport; returns the ack receipt. */
  dispatch(request: ProjectionDispatchRequest): Promise<IntentAck> {
    const intent: Intent = {
      intentId: request.intentId ?? newIntentId(),
      kind: request.kind,
      payload: request.payload ?? {},
      clientId: request.clientId ?? newClientId(),
    };
    return this.transport.dispatch(intent);
  }

  /** The current recorded frames + cache for a subscription. */
  state(subscriptionId: string): ProjectionRecordingState {
    return this.stateOf(subscriptionId, this.require(subscriptionId));
  }

  /**
   * Schedule the next `count` delivered diffs on a subscription to be dropped
   * before reaching its cache — the forced-gap control. The dropped diffs are
   * still recorded in {@link ProjectionRecordingState.frames}.
   */
  dropNext(subscriptionId: string, count: number): void {
    this.require(subscriptionId).dropRemaining = Math.max(0, Math.trunc(count));
  }

  /**
   * Explicitly re-baseline a subscription's cache from the backend, returning the
   * cache state afterward. The gap path resyncs automatically; this drives the
   * command directly (e.g. after a simulated reconnect).
   */
  async resync(subscriptionId: string): Promise<ProjectionRecordingState> {
    const recording = this.require(subscriptionId);
    await recording.client.resync();
    return this.stateOf(subscriptionId, recording);
  }

  /** Detach one subscription. Idempotent. */
  unsubscribe(subscriptionId: string): void {
    const recording = this.recordings.get(subscriptionId);
    if (!recording) return;
    recording.client.stop();
    this.recordings.delete(subscriptionId);
  }

  /** Detach every subscription and clear all buffers (per-test cleanup). */
  reset(): void {
    for (const recording of this.recordings.values()) recording.client.stop();
    this.recordings.clear();
  }

  private require(subscriptionId: string): Recording {
    const recording = this.recordings.get(subscriptionId);
    if (!recording) {
      throw new Error(`no projection subscription "${subscriptionId}"`);
    }
    return recording;
  }

  private stateOf(
    subscriptionId: string,
    recording: Recording
  ): ProjectionRecordingState {
    if (!recording.snapshot) {
      throw new Error(`subscription "${subscriptionId}" has no snapshot yet`);
    }
    return {
      subscriptionId,
      region: recording.region,
      snapshot: recording.snapshot,
      // Copy the buffer so a later push cannot mutate an already-returned result.
      frames: [...recording.frames],
      cache: recording.client.state,
      dropRemaining: recording.dropRemaining,
    };
  }
}
