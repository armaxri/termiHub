/**
 * Wire envelopes for the stateless-UI projection substrate (#2149).
 *
 * These types are the twin of the Rust `serde` structs in
 * `src-tauri/src/projection/frame.rs`. They are transport-neutral: identical
 * whether they ride Tauri IPC (desktop) or JSON-RPC over WebSocket
 * (remote-client mode). See the design concept
 * `docs/concepts/future/stateless-ui-projection-substrate.html`.
 *
 * The substrate carries two new generic channels:
 * - channel 1 `dispatch(intent)` (UI → backend): one {@link Intent}, answered
 *   by an {@link IntentAck} receipt.
 * - channel 2 `subscribe(region)` (backend → UI): an initial
 *   {@link SnapshotFrame} then an ordered stream of {@link DiffFrame}s.
 *
 * The terminal `terminal-output` byte stream is channel 3 and is wholly
 * independent of this module.
 */

/** A user intent dispatched by a client (channel 1, UI → backend). */
export interface Intent<P = unknown> {
  /** Client-generated ULID; correlates the ack (and any optimistic echo). */
  intentId: string;
  /** Dotted `<domain>.<action>`, e.g. `"tunnel.start"`, `"layout.moveTab"`. */
  kind: string;
  /** Kind-specific, serialisable payload; validated backend-side. */
  payload: P;
  /** Which attached client dispatched it (fan-out / audit identity). */
  clientId: string;
}

/** Error detail attached to a rejected {@link IntentAck}. */
export interface IntentError {
  code: string;
  message: string;
}

/** A region advanced by an intent, so a client can await the confirming diff. */
export interface ProducedRegion {
  region: string;
  version: number;
}

/**
 * Receipt for a dispatched {@link Intent} (channel 1 reply).
 *
 * The ack is a receipt, not the result: the result of an intent is always a
 * projection diff on the affected region(s), never data returned inline.
 */
export interface IntentAck {
  /** Echoes the request's `intentId`. */
  intentId: string;
  status: "accepted" | "rejected";
  /** Present iff `status === "rejected"`. */
  error?: IntentError;
  /** Regions this intent advanced. Empty/absent for no-op / query intents. */
  produced?: ProducedRegion[];
}

/** A projection frame pushed to a subscriber (channel 2, backend → UI). */
export type ProjectionFrame = SnapshotFrame | DiffFrame;

/**
 * The complete, render-ready view model for a region at a baseline version.
 * Emitted on attach and on resync only; steady state is {@link DiffFrame}s.
 */
export interface SnapshotFrame {
  region: string;
  kind: "snapshot";
  /** `u64` monotonic; the cache adopts this as its baseline. */
  version: number;
  /** The complete, render-ready view model for the region. */
  view: unknown;
}

/** An ordered mutation of a region's cached view model. */
export interface DiffFrame {
  region: string;
  kind: "diff";
  /** MUST equal the cache's current version, else it is a gap. */
  baseVersion: number;
  /** `=== baseVersion + 1`. */
  version: number;
  /** Ordered mutations to apply to the cached view model. */
  ops: DiffOp[];
}

/**
 * A single diff operation.
 *
 * The default shape is an RFC 6902 JSON-Patch subset (`add` / `remove` /
 * `replace`). The `semantic` variant is the per-domain compact-op escape hatch
 * reserved by the design; it is unused in Phase 1.
 */
export type DiffOp =
  | { op: "replace"; path: string; value: unknown }
  | { op: "add"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "semantic"; name: string; data: unknown };
