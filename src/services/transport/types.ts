/**
 * Wire envelopes for the stateless-UI projection substrate (#2149).
 *
 * These types are generated via ts-rs from the Rust `serde` structs in
 * `src-tauri/src/projection/frame.rs` (#3088, audit DUP-030), so the two sides
 * cannot drift. They are transport-neutral: identical whether they ride Tauri
 * IPC (desktop) or JSON-RPC over WebSocket (remote-client mode). See the design
 * concept `docs/concepts/future/stateless-ui-projection-substrate.html`.
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

export type { Intent } from "@/types/generated/Intent";
export type { IntentAck } from "@/types/generated/IntentAck";
export type { IntentError } from "@/types/generated/IntentError";
export type { IntentStatus } from "@/types/generated/IntentStatus";
export type { ProducedRegion } from "@/types/generated/ProducedRegion";
export type { ProjectionFrame } from "@/types/generated/ProjectionFrame";
export type { SnapshotFrame } from "@/types/generated/SnapshotFrame";
export type { DiffFrame } from "@/types/generated/DiffFrame";
export type { DiffOp } from "@/types/generated/DiffOp";
