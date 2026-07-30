/**
 * The transport abstraction shared with remote-client mode.
 *
 * A `Transport` carries the substrate's two generic channels over whichever
 * link is selected — Tauri IPC on desktop ({@link TauriTransport}) or JSON-RPC
 * over WebSocket in remote-client mode ({@link WebSocketTransport}). It owns
 * *where the bytes travel*; the {@link ProjectionClient} owns *what state-shaped
 * messages travel over it*.
 */

import type { Intent, IntentAck, ProjectionFrame, SnapshotFrame } from "./types";

/** A live subscription to a region's diff stream. */
export interface Subscription {
  /** The snapshot returned at attach time; the cache's initial baseline. */
  readonly snapshot: SnapshotFrame;
  /** Detach from the region. Idempotent. */
  unsubscribe(): void;
}

/** Callback invoked for every frame pushed on a subscribed region. */
export type FrameHandler = (frame: ProjectionFrame) => void;

/**
 * Transport-neutral access to the projection substrate.
 *
 * Implementations must preserve per-region ordering of pushed frames; there is
 * no cross-region ordering guarantee.
 */
export interface Transport {
  /**
   * Channel 1 — dispatch a user intent; resolves with the ack receipt. The
   * result of an accepted intent arrives separately as a projection diff on
   * the affected region(s).
   */
  dispatch(intent: Intent): Promise<IntentAck>;

  /**
   * Channel 2 — attach to a region. Resolves once the initial snapshot has
   * arrived; every subsequent frame for the region is delivered to `onFrame`
   * in order. Snapshot and stream-start are atomic backend-side, so no diff
   * can slip between the snapshot's version and the first streamed diff.
   */
  subscribe(region: string, onFrame: FrameHandler): Promise<Subscription>;

  /**
   * Recover a region after a detected gap or a reconnect. `have` lets the
   * backend skip work if the client is already current: it resolves to `null`
   * when `have` already matches the region's current version, otherwise to a
   * fresh snapshot to re-baseline from.
   */
  resync(region: string, have?: number): Promise<SnapshotFrame | null>;
}
