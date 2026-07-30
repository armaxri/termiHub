/**
 * Projection substrate transport (#2149) — public surface.
 *
 * The transport abstraction is shared with remote-client mode: on desktop it
 * rides Tauri IPC ({@link TauriTransport}); in a browser it rides JSON-RPC over
 * WebSocket ({@link WebSocketTransport}). {@link ProjectionClient} is the dumb
 * per-region cache that sits on top of whichever transport is selected.
 */

import { TauriTransport } from "./TauriTransport";
import type { Transport } from "./Transport";
import { WebSocketTransport, type JsonRpcSocket } from "./WebSocketTransport";

export type {
  DiffFrame,
  DiffOp,
  Intent,
  IntentAck,
  IntentError,
  ProducedRegion,
  ProjectionFrame,
  SnapshotFrame,
} from "./types";
export type { FrameHandler, Subscription, Transport } from "./Transport";
export { TauriTransport } from "./TauriTransport";
export { WebSocketTransport, type JsonRpcSocket } from "./WebSocketTransport";
export {
  ProjectionClient,
  type CacheListener,
  type ProjectionCacheState,
} from "./ProjectionClient";
export { newClientId, newIntentId } from "./ids";

/** True when running inside the Tauri desktop shell. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}

/**
 * Select the transport for the current environment: {@link TauriTransport} in
 * the desktop shell, otherwise a {@link WebSocketTransport} over the provided
 * JSON-RPC socket (remote-client mode). Throws in a non-Tauri environment when
 * no socket is supplied, since the WebSocket server is remote-client mode's
 * Phase 2 and not yet wired.
 */
export function createTransport(opts?: { socket?: JsonRpcSocket }): Transport {
  if (isTauri()) return new TauriTransport();
  if (opts?.socket) return new WebSocketTransport(opts.socket);
  throw new Error(
    "non-Tauri environment requires a JSON-RPC socket (remote-client mode transport)"
  );
}
