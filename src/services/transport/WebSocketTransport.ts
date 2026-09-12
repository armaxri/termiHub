/**
 * Remote-client transport: rides JSON-RPC over a WebSocket.
 *
 * The substrate's envelopes become additional JSON-RPC methods
 * (`intent.dispatch`, `projection.subscribe`, `projection.unsubscribe`,
 * `projection.resync`) and a `projection.frame` server→client notification,
 * carried by whichever transport remote-client mode selects — no second
 * transport layer.
 *
 * The concrete WebSocket server is remote-client mode's Phase 2 and does not
 * exist yet; this transport depends only on a minimal {@link JsonRpcSocket}
 * abstraction so it is fully unit-testable with a fake socket today and drops
 * onto the real socket unchanged once it lands.
 */

import { newClientId } from "./ids";
import type { FrameHandler, Subscription, Transport } from "./Transport";
import type { Intent, IntentAck, ProjectionFrame, SnapshotFrame } from "./types";

/** The minimal JSON-RPC surface the transport needs from a socket. */
export interface JsonRpcSocket {
  /** Send a request and await its result. */
  request<T>(method: string, params: unknown): Promise<T>;
  /**
   * Register a handler for a server→client notification method. Returns a
   * function that removes the handler.
   */
  onNotification(method: string, handler: (params: unknown) => void): () => void;
}

export class WebSocketTransport implements Transport {
  /**
   * Frame handlers keyed by region, each region holding a *set* of subscribers.
   * Multiple consumers may attach to one region (matching {@link TauriTransport},
   * which keys a distinct channel per `subscriptionId`); every frame fans out to
   * all of them, and each unsubscribe removes only its own handler (FEC-007).
   */
  private readonly handlers = new Map<string, Set<FrameHandler>>();
  private notificationHandle?: () => void;
  private subCounter = 0;

  constructor(
    private readonly socket: JsonRpcSocket,
    private readonly clientId: string = newClientId()
  ) {}

  async dispatch(intent: Intent): Promise<IntentAck> {
    return this.socket.request<IntentAck>("intent.dispatch", { intent });
  }

  async subscribe(region: string, onFrame: FrameHandler): Promise<Subscription> {
    this.ensureListener();
    const subscriptionId = `${this.clientId}:${region}:${this.subCounter++}`;
    let regionHandlers = this.handlers.get(region);
    if (!regionHandlers) {
      regionHandlers = new Set<FrameHandler>();
      this.handlers.set(region, regionHandlers);
    }
    regionHandlers.add(onFrame);

    const snapshot = await this.socket.request<SnapshotFrame>("projection.subscribe", {
      region,
      subscriptionId,
      clientId: this.clientId,
    });

    let active = true;
    return {
      snapshot,
      unsubscribe: () => {
        if (!active) return;
        active = false;
        this.removeHandler(region, onFrame);
        void this.socket
          .request("projection.unsubscribe", { region, subscriptionId })
          .catch(() => {});
      },
    };
  }

  async resync(region: string, have?: number): Promise<SnapshotFrame | null> {
    return this.socket.request<SnapshotFrame | null>("projection.resync", {
      region,
      have: have ?? null,
    });
  }

  /**
   * Tear down the transport: drop every subscriber and detach the underlying
   * notification listener. Idempotent.
   */
  close(): void {
    this.handlers.clear();
    this.teardownListener();
  }

  /** Remove one subscriber; clean up the region and listener when empty. */
  private removeHandler(region: string, onFrame: FrameHandler): void {
    const regionHandlers = this.handlers.get(region);
    if (!regionHandlers) return;
    regionHandlers.delete(onFrame);
    if (regionHandlers.size === 0) this.handlers.delete(region);
    // Once the last subscriber across all regions has left, nothing is listening
    // — detach the shared notification handler so it does not outlive its uses.
    if (this.handlers.size === 0) this.teardownListener();
  }

  private teardownListener(): void {
    this.notificationHandle?.();
    this.notificationHandle = undefined;
  }

  /** Route the single `projection.frame` notification stream by region. */
  private ensureListener(): void {
    if (this.notificationHandle) return;
    this.notificationHandle = this.socket.onNotification("projection.frame", (params) => {
      const frame = params as ProjectionFrame;
      const regionHandlers = this.handlers.get(frame.region);
      if (!regionHandlers) return;
      // Snapshot the set so a handler that unsubscribes during dispatch does not
      // perturb the in-flight iteration.
      for (const handler of [...regionHandlers]) handler(frame);
    });
  }
}
