/**
 * Per-region cache adapter for the projection substrate (#2149).
 *
 * Holds `{ version, view }` for one region, applies ordered diffs, detects
 * gaps (`baseVersion !== version`) and re-baselines via `resync`, and notifies
 * listeners on every change. It computes and decides nothing about the view —
 * the backend is the single authoritative writer; this is a dumb cache.
 *
 * Diffs are applied with the maintained `fast-json-patch` package (RFC 6902),
 * the mirror of the Rust reference applier `projection::apply_ops`.
 */

import { applyPatch, type Operation } from "fast-json-patch";

import type { FrameHandler, Subscription, Transport } from "./Transport";
import type { DiffFrame, ProjectionFrame, SnapshotFrame } from "./types";

/** The cache's public state for one region. */
export interface ProjectionCacheState {
  /** `-1` until the first snapshot is adopted. */
  version: number;
  view: unknown;
}

/** Notified with the new cache state on every change. */
export type CacheListener = (state: ProjectionCacheState) => void;

export class ProjectionClient {
  private version = -1;
  private view: unknown = undefined;
  private subscription?: Subscription;
  private readonly listeners = new Set<CacheListener>();
  private closed = false;
  private resyncing = false;

  constructor(
    private readonly transport: Transport,
    public readonly region: string
  ) {}

  /** Current cached `{ version, view }`. */
  get state(): ProjectionCacheState {
    return { version: this.version, view: this.view };
  }

  /** Subscribe a listener; returns an unsubscribe function. */
  onChange(listener: CacheListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Attach to the region and adopt its snapshot as the baseline. */
  async start(): Promise<void> {
    this.closed = false;
    const onFrame: FrameHandler = (frame) => this.onFrame(frame);
    this.subscription = await this.transport.subscribe(this.region, onFrame);
    this.adoptSnapshot(this.subscription.snapshot);
  }

  /** Detach and stop applying frames. Idempotent. */
  stop(): void {
    this.closed = true;
    this.subscription?.unsubscribe();
    this.subscription = undefined;
  }

  private onFrame(frame: ProjectionFrame): void {
    if (this.closed) return;
    if (frame.kind === "snapshot") {
      this.adoptSnapshot(frame);
      return;
    }
    this.applyDiff(frame);
  }

  private adoptSnapshot(snapshot: SnapshotFrame): void {
    this.version = snapshot.version;
    this.view = snapshot.view;
    this.emit();
  }

  private applyDiff(diff: DiffFrame): void {
    // Gap: a frame was dropped, reordered, or the stream reconnected. Discard
    // and re-baseline rather than apply out of order.
    if (diff.baseVersion !== this.version) {
      void this.resync();
      return;
    }
    // The semantic-op escape hatch has no RFC 6902 apply path (unused in Phase
    // 1); fall back to a resync rather than apply a frame we cannot interpret.
    if (diff.ops.some((op) => op.op === "semantic")) {
      void this.resync();
      return;
    }
    const result = applyPatch(this.view, diff.ops as Operation[], false, false);
    this.view = result.newDocument;
    this.version = diff.version;
    this.emit();
  }

  /**
   * Re-baseline the region from the backend. A `null` response means the cache
   * is already current (nothing to adopt). Guarded against concurrent runs.
   */
  async resync(): Promise<void> {
    if (this.closed || this.resyncing) return;
    this.resyncing = true;
    try {
      const have = this.version >= 0 ? this.version : undefined;
      const snapshot = await this.transport.resync(this.region, have);
      if (snapshot && !this.closed) {
        this.adoptSnapshot(snapshot);
      }
    } finally {
      this.resyncing = false;
    }
  }

  private emit(): void {
    const state = this.state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
