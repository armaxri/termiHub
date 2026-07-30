/**
 * Desktop transport: rides Tauri IPC.
 *
 * `dispatch` wraps the `intent_dispatch` command; `subscribe` opens a
 * per-region `tauri::ipc::Channel` (efficient per-region push) and returns the
 * snapshot from `projection_subscribe`. See
 * `src-tauri/src/commands/projection.rs`.
 */

import { Channel, invoke } from "@tauri-apps/api/core";

import { newClientId } from "./ids";
import type { FrameHandler, Subscription, Transport } from "./Transport";
import type { Intent, IntentAck, ProjectionFrame, SnapshotFrame } from "./types";

export class TauriTransport implements Transport {
  private subCounter = 0;

  constructor(private readonly clientId: string = newClientId()) {}

  async dispatch(intent: Intent): Promise<IntentAck> {
    return invoke<IntentAck>("intent_dispatch", { intent });
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
