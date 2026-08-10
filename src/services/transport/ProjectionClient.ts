/**
 * Per-region cache adapter for the projection substrate (#2149).
 *
 * Holds `{ version, view }` for one region, applies ordered diffs, detects
 * gaps (`baseVersion !== version`) and re-baselines via `resync`, and notifies
 * listeners on every change. The backend is the single authoritative writer;
 * the cache computes nothing about the authoritative view.
 *
 * # Optimistic client-side folding (#2533)
 *
 * On top of the authoritative baseline the cache carries an **optimistic
 * overlay**: a dispatching client can apply its own intent to its local view
 * *synchronously* via {@link ProjectionClient.dispatchOptimistic}, so a
 * component reading the projection sees its own intent immediately instead of
 * only after a full backend round-trip. This closes the hot-path overlay gap
 * that the appStore local writes cover today (#2205 / #2283).
 *
 * The overlay is a list of pending {@link OptimisticFold}s applied over the
 * authoritative `baseView` to produce the effective view. Reconcile is
 * **version-gated**: the intent's ack reports the region version its change
 * lands at, and the fold is dropped once the cache reaches that version — at
 * which point the authoritative diff/snapshot already carries the real change,
 * so the authoritative state supersedes the optimistic one with no double-apply
 * and no drift. Divergence is handled the same way: a rejected intent, or one
 * that produced no change on this region, is rolled back at once (there is no
 * confirming version to wait for), so an optimistic entry is never stranded.
 *
 * Regions that never call {@link dispatchOptimistic} keep an empty overlay, so
 * their effective view is reference-identical to the authoritative baseline —
 * the already-inverted domains are unaffected.
 *
 * Diffs are applied with the maintained `fast-json-patch` package (RFC 6902),
 * the mirror of the Rust reference applier `projection::apply_ops`. Diffs and
 * snapshots always target the authoritative `baseView`, never the overlay.
 */

import { applyPatch, type Operation } from "fast-json-patch";

import type { FrameHandler, Subscription, Transport } from "./Transport";
import type { DiffFrame, Intent, IntentAck, ProjectionFrame, SnapshotFrame } from "./types";

/** The cache's public state for one region. */
export interface ProjectionCacheState {
  /** `-1` until the first snapshot is adopted. */
  version: number;
  view: unknown;
}

/** Notified with the new cache state on every change. */
export type CacheListener = (state: ProjectionCacheState) => void;

/**
 * A pure optimistic transform of a region view (#2533): given the current
 * effective view, return the view as it should appear once the dispatched
 * intent has been applied — the client-side twin of the backend reducer for
 * that intent.
 *
 * **Must not mutate its input** (the authoritative baseline is shared) and
 * should be **idempotent / last-writer** in shape: while the intent is in
 * flight the fold may briefly be layered over a baseline that already carries
 * the backend's own application of it, until the confirming version prunes it.
 * A full-entry replace (as the session-lifecycle folds use) satisfies this.
 */
export type OptimisticFold = (view: unknown) => unknown;

/** One in-flight optimistic overlay awaiting its authoritative confirmation. */
interface PendingFold {
  intentId: string;
  fold: OptimisticFold;
  /** The region version at which the backend applied this intent (from the
   * ack's `produced`); `undefined` until the ack resolves. The fold is dropped
   * once `version >= confirmVersion`. */
  confirmVersion?: number;
}

export class ProjectionClient {
  private version = -1;
  /** The authoritative baseline; diffs and snapshots apply here. */
  private baseView: unknown = undefined;
  /** The overlaid view emitted to listeners: `baseView` with the pending
   * optimistic folds applied. Reference-identical to `baseView` when there is
   * no overlay. */
  private effective: unknown = undefined;
  /** In-flight optimistic overlays, in dispatch order (#2533). */
  private pending: PendingFold[] = [];
  private subscription?: Subscription;
  private readonly listeners = new Set<CacheListener>();
  private closed = false;
  private resyncing = false;

  constructor(
    private readonly transport: Transport,
    public readonly region: string
  ) {}

  /** Current cached `{ version, view }` (the effective, overlaid view). */
  get state(): ProjectionCacheState {
    return { version: this.version, view: this.effective };
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

  /**
   * Dispatch an intent and apply its optimistic {@link OptimisticFold} to the
   * local view **synchronously**, so a subscriber reading the projection sees
   * this client's own intent immediately — before the authoritative
   * diff/snapshot arrives (#2533).
   *
   * The overlay is reconciled against the authoritative stream:
   * - **accepted** with a produced version on this region → the fold is kept
   *   until the cache reaches that version (the diff/snapshot then carries the
   *   real change), then dropped — the authoritative state supersedes it.
   * - **accepted with no change on this region**, or **rejected** → nothing
   *   authoritative will confirm the fold, so it is rolled back at once
   *   (divergence handling; the overlay is never stranded).
   * - the **dispatch throwing** → the fold is rolled back and the error
   *   rethrown, so the caller's fallback path runs on a clean view.
   *
   * Resolves with the ack (a receipt; the result rides the region diff).
   */
  async dispatchOptimistic(intent: Intent, fold: OptimisticFold): Promise<IntentAck> {
    const entry: PendingFold = { intentId: intent.intentId, fold };
    this.pending.push(entry);
    this.recompute();
    this.emit();

    let ack: IntentAck;
    try {
      ack = await this.transport.dispatch(intent);
    } catch (err) {
      // The intent never reached the backend; roll the overlay back so the
      // caller's fallback path sees an un-diverged view.
      this.dropPending(entry);
      throw err;
    }

    const produced =
      ack.status === "accepted"
        ? ack.produced?.find((p) => p.region === this.region)
        : undefined;
    if (!produced) {
      // Rejected, or a no-op / divergence that produced no change on this
      // region: no confirming version will ever arrive, so roll back now.
      this.dropPending(entry);
    } else {
      entry.confirmVersion = produced.version;
      // The confirming diff may already have landed (it raced the ack); prune
      // immediately if so.
      if (this.pruneConfirmed()) this.emit();
    }
    return ack;
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
    this.baseView = snapshot.view;
    this.pruneConfirmed();
    this.recompute();
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
    // Authoritative diffs always apply to the baseline, never the overlay.
    const result = applyPatch(this.baseView, diff.ops as Operation[], false, false);
    this.baseView = result.newDocument;
    this.version = diff.version;
    this.pruneConfirmed();
    this.recompute();
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

  /** Recompute the effective (overlaid) view from `baseView` + `pending`. */
  private recompute(): void {
    this.effective =
      this.pending.length === 0
        ? this.baseView
        : this.pending.reduce((view, p) => p.fold(view), this.baseView);
  }

  /** Drop a single pending overlay (rollback) and re-emit. */
  private dropPending(entry: PendingFold): void {
    const index = this.pending.indexOf(entry);
    if (index === -1) return;
    this.pending.splice(index, 1);
    this.recompute();
    this.emit();
  }

  /**
   * Drop every pending overlay whose confirming version the cache has now
   * reached — the authoritative view already carries the change. Recomputes
   * the effective view; returns whether anything was dropped (the caller emits).
   */
  private pruneConfirmed(): boolean {
    if (this.pending.length === 0) return false;
    const before = this.pending.length;
    this.pending = this.pending.filter(
      (p) => p.confirmVersion === undefined || this.version < p.confirmVersion
    );
    const changed = this.pending.length !== before;
    if (changed) this.recompute();
    return changed;
  }

  private emit(): void {
    const state = this.state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
