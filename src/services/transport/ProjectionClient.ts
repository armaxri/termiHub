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
 * Diffs are RFC 6902 (`add` / `remove` / `replace`), the mirror of the Rust
 * reference applier `projection::apply_ops`. They are applied with **immer**'s
 * copy-on-write `applyPatches` (PERF-005): the new baseline shares every
 * untouched subtree by reference with the previous view and re-identifies only
 * the touched paths — O(diff) allocation instead of the O(whole-region) deep
 * clone `fast-json-patch`'s non-mutating mode did. `fast-json-patch` is retained
 * only for the degenerate primitive-base fallback and for the `compare` used by
 * callers/tests. Diffs and snapshots always target the authoritative `baseView`,
 * never the overlay.
 *
 * ## Immutability invariant (why copy-on-write is safe here)
 *
 * Downstream consumers hold references to previously-emitted views and rely on
 * them staying immutable (React referential-equality diffing). immer never
 * mutates the `base` it is given — it copies-on-write — so applying a later diff
 * produces a fresh document without touching any object a prior emission handed
 * out. Auto-freeze is disabled ({@link setAutoFreeze}) so an emitted view is
 * byte-for-byte what the old deep-clone applier produced (plain, unfrozen
 * objects); only the allocation/sharing changes, not the observable document.
 */

import { applyPatch, type Operation } from "fast-json-patch";
import { applyPatches, enablePatches, setAutoFreeze, type Patch } from "immer";

import type { FrameHandler, Subscription, Transport } from "./Transport";
import type { DiffFrame, DiffOp, Intent, IntentAck, ProjectionFrame, SnapshotFrame } from "./types";

// immer's patch plugin powers {@link applyDiffOps}; enable it once at load. Keep
// produced documents UNFROZEN so an emitted view is identical to the deep-clone
// applier's output — copy-on-write already guarantees the immutability invariant
// (a later diff never mutates a previously-emitted view) without freezing.
enablePatches();
setAutoFreeze(false);

/** A diff op that carries an RFC 6901 path (everything but the `semantic` op). */
type PatchOp = Exclude<DiffOp, { op: "semantic" }>;

/**
 * Decode an RFC 6901 JSON Pointer (`/a/b~1c`) to immer's array-path form
 * (`["a", "b/c"]`). Segments stay strings; immer coerces them for array indices
 * and handles the `-` append token natively.
 */
function jsonPointerToPath(pointer: string): string[] {
  if (pointer === "") return [];
  return pointer
    .split("/")
    .slice(1)
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** Convert an RFC 6902 diff op to immer's `Patch` shape (array path). */
function toImmerPatch(op: PatchOp): Patch {
  const path = jsonPointerToPath(op.path);
  return op.op === "remove" ? { op: "remove", path } : { op: op.op, path, value: op.value };
}

/**
 * Apply an ordered RFC 6902 op list to `base`, returning a NEW document that
 * shares every untouched subtree by reference with `base` (copy-on-write via
 * immer). `base` is never mutated, so any previously-emitted view aliasing its
 * subtrees stays intact (PERF-005). Only `add`/`remove`/`replace` reach here —
 * the backend's `json_patch::diff` emits no move/copy/test, and `semantic` ops
 * are resynced upstream — all of which immer's `applyPatches` represents
 * faithfully.
 */
function applyDiffOps(base: unknown, ops: DiffOp[]): unknown {
  // A region view model is always an object/array; only such a base can carry a
  // path-addressed diff. Guard the degenerate primitive case with the plain
  // deep-clone applier (behaviour-identical) so a malformed frame cannot throw
  // out of the frame handler.
  if (base === null || typeof base !== "object") {
    return applyPatch(base, ops as unknown as Operation[], false, false).newDocument;
  }
  const patches: Patch[] = [];
  for (const op of ops) {
    if (op.op === "semantic") continue; // never reached (resynced upstream); narrows the union
    patches.push(toImmerPatch(op));
  }
  return applyPatches(base as object, patches);
}

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
  /** True once the initial snapshot has been adopted (baseline established). */
  private snapshotAdopted = false;
  /**
   * Frames that arrived on the transport channel *before* the initial snapshot
   * was adopted (CONC-012). The channel is wired before `subscribe` resolves, so
   * a diff can reach {@link onFrame} while `version` is still `-1`; buffering it
   * and flushing after {@link adoptSnapshot} keeps ordering without falling into
   * a redundant resync.
   */
  private preSnapshotBuffer: ProjectionFrame[] = [];

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
    this.snapshotAdopted = false;
    this.preSnapshotBuffer = [];
    const onFrame: FrameHandler = (frame) => this.onFrame(frame);
    this.subscription = await this.transport.subscribe(this.region, onFrame);
    this.adoptSnapshot(this.subscription.snapshot);
    this.flushPreSnapshotBuffer();
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
      ack.status === "accepted" ? ack.produced?.find((p) => p.region === this.region) : undefined;
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
    if (!this.snapshotAdopted) {
      // A frame reached the channel before the initial snapshot was adopted
      // (the transport wires the handler before `subscribe` resolves). Buffer it
      // and apply it in order once the baseline is set, instead of treating it
      // as a gap and forcing a redundant resync (CONC-012).
      this.preSnapshotBuffer.push(frame);
      return;
    }
    if (frame.kind === "snapshot") {
      this.adoptSnapshot(frame);
      return;
    }
    this.applyDiff(frame);
  }

  /** Apply frames that arrived before the baseline, in arrival order. */
  private flushPreSnapshotBuffer(): void {
    if (this.preSnapshotBuffer.length === 0) return;
    const buffered = this.preSnapshotBuffer;
    this.preSnapshotBuffer = [];
    for (const frame of buffered) {
      if (this.closed) return;
      this.onFrame(frame);
    }
  }

  private adoptSnapshot(snapshot: SnapshotFrame): void {
    // Never regress: a late/racing snapshot (e.g. a resync that resolves after a
    // newer diff already advanced the cache) must not roll the version backwards
    // (CONC-012). The initial adoption always proceeds (`snapshotAdopted` false).
    if (this.snapshotAdopted && snapshot.version < this.version) return;
    this.snapshotAdopted = true;
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
    // Copy-on-write: the new baseline shares untouched subtrees with the prior
    // view and never mutates it (PERF-005).
    this.baseView = applyDiffOps(this.baseView, diff.ops);
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
