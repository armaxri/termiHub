/**
 * Desktop transport: rides Tauri IPC.
 *
 * `dispatch` wraps the `intent_dispatch` command; `subscribe` opens a
 * per-region `tauri::ipc::Channel` (efficient per-region push) and returns the
 * snapshot from `projection_subscribe`. See
 * `src-tauri/src/commands/projection.rs`.
 *
 * # Intent ordering (#4826)
 *
 * Intents are delivered to the backend **in dispatch order**. Callers rely on
 * that: the layout bridge seeds the backend with `layout.replaceGroups(pre)` and
 * then dispatches the granular intent (e.g. `layout.addTab`) without awaiting
 * the seed, trusting the transport's FIFO delivery. Tauri IPC does not give
 * that guarantee on its own: every `invoke` is an independent custom-protocol
 * `fetch`, and WebView2 can raise the requests out of order (a larger POST body,
 * such as a whole-layout seed, can be handed to the backend after the smaller
 * intent that followed it). The stale seed then overwrites the tab the intent
 * just added, and the tab vanishes from the layout while its terminal is still
 * connecting. So each `intent_dispatch` is issued only once the previous one
 * has settled. The backend already applies intents one at a time under its
 * writer lock, so this costs one IPC round-trip of latency per queued intent
 * and no throughput; optimistic overlays still apply synchronously.
 */

import { Channel, invoke } from "@tauri-apps/api/core";

import { newClientId } from "./ids";
import type { FrameHandler, Subscription, Transport } from "./Transport";
import type { Intent, IntentAck, ProjectionFrame, SnapshotFrame } from "./types";

export class TauriTransport implements Transport {
  private subCounter = 0;
  /** Settles once the most recently issued `intent_dispatch` has settled;
   * `null` while no dispatch is in flight. */
  private dispatchTail: Promise<unknown> | null = null;

  constructor(private readonly clientId: string = newClientId()) {}

  dispatch(intent: Intent): Promise<IntentAck> {
    const send = (): Promise<IntentAck> => invoke<IntentAck>("intent_dispatch", { intent });
    // Idle: invoke synchronously, exactly as an unqueued dispatch would. Busy:
    // chain on the previous dispatch's settlement (success or failure), so a
    // rejected invoke never stalls the intents queued behind it.
    const next = this.dispatchTail ? this.dispatchTail.then(send) : send();
    const tail: Promise<unknown> = next.then(
      () => undefined,
      () => undefined
    );
    this.dispatchTail = tail;
    void tail.then(() => {
      if (this.dispatchTail === tail) this.dispatchTail = null;
    });
    return next;
  }

  async subscribe(region: string, onFrame: FrameHandler): Promise<Subscription> {
    const subscriptionId = `${this.clientId}:${region}:${this.subCounter++}`;
    const channel = new Channel<ProjectionFrame>();
    channel.onmessage = onFrame;

    const snapshot = await invoke<SnapshotFrame>("projection_subscribe", {
      region,
      subscriptionId,
      clientId: this.clientId,
      channel,
    });

    let active = true;
    return {
      snapshot,
      unsubscribe: () => {
        if (!active) return;
        active = false;
        void invoke("projection_unsubscribe", { region, subscriptionId });
      },
    };
  }

  async resync(region: string, have?: number): Promise<SnapshotFrame | null> {
    return invoke<SnapshotFrame | null>("projection_resync", {
      region,
      have: have ?? null,
    });
  }
}
