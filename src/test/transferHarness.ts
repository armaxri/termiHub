/**
 * Test harness for the authoritative `transfers` projection region (#2229).
 *
 * Since the Transfers reducer removal made the region the single source of truth,
 * tests can no longer seed transfer-queue state into `appStore` — they seed it
 * into the region. {@link FakeTransferTransport} is an in-memory twin of the Rust
 * `TransferStore`: it holds one `transfers` view (the per-transfer queue map plus
 * the panel-minimized flag), folds the granular `transfer.*` intents exactly as
 * the backend store does (reusing the same `transferEntryFrom*` helpers the store
 * mirrors one-to-one), and fans a fresh snapshot to every subscriber. {@link seed}
 * pre-populates the view for a test's initial render;
 * {@link FakeTransferTransport.dispatched} records dispatched intents for
 * assertions.
 */

import type {
  FrameHandler,
  Intent,
  IntentAck,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";
import type { TransferProgress, TransferSnapshot } from "@/services/api";
import {
  setTransferTransportForTest,
  stopTransfersSubscription,
  TRANSFERS_REGION,
  type TransfersView,
} from "@/store/transfersBridge";
import {
  isTerminalTransferState,
  transferEntryFromProgress,
  transferEntryFromSeed,
  transferEntryFromSnapshot,
  type TransferDirection,
  type TransferEntry,
  type TransferSeed,
} from "@/types/transfer";

/** A deterministic queue row, defaulting to an `active` download at 50 %. */
export function fakeTransferEntry(
  id: string,
  overrides: Partial<TransferEntry> = {}
): TransferEntry {
  return {
    id,
    sessionId: `sess-${id}`,
    direction: "download" as TransferDirection,
    name: `${id}.bin`,
    state: "active",
    transferred: 500,
    totalBytes: 1000,
    percent: 50,
    speedBytesPerSec: null,
    updatedAt: 0,
    ...overrides,
  };
}

/** Build a `transfers` view from a list of queue rows (+ optional minimized). */
export function transfersView(entries: TransferEntry[], minimized = false): TransfersView {
  const queue: Record<string, TransferEntry> = {};
  for (const e of entries) queue[e.id] = e;
  return { queue, minimized };
}

/**
 * An in-memory substrate double for the `transfers` region: holds one view, folds
 * the granular `transfer.*` intents like the Rust store, and fans a snapshot to
 * every subscriber. Faithful enough that a client-dispatched intent round-trips
 * back into the projected view. The `seed`/`progress`/`reconcile` folds reuse the
 * frontend `transferEntryFrom*` helpers, which mirror the Rust store's
 * `entry_from_*` folds one-to-one.
 */
export class FakeTransferTransport implements Transport {
  dispatched: Intent[] = [];
  private view: TransfersView = { queue: {}, minimized: false };
  private version = 0;
  private handlers = new Set<FrameHandler>();
  private clock = 0;

  /** Seed the region view directly (test setup), fanning a snapshot. */
  seed(view: TransfersView): void {
    this.view = { queue: { ...view.queue }, minimized: view.minimized };
    this.bump();
  }

  /** Intent kinds dispatched, in order (assertion helper). */
  kinds(): string[] {
    return this.dispatched.map((i) => i.kind);
  }

  private now(): number {
    this.clock += 1;
    return this.clock;
  }

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    const p = intent.payload as Record<string, unknown>;
    const queue = this.view.queue;
    switch (intent.kind) {
      case "transfer.seed": {
        const seed = p.seed as TransferSeed;
        // Idempotent: never overwrite an already-present (event-advanced) row.
        if (!(seed.id in queue)) {
          this.view.queue = { ...queue, [seed.id]: transferEntryFromSeed(seed, this.now()) };
        }
        break;
      }
      case "transfer.progress": {
        const progress = p.progress as TransferProgress;
        const prev = queue[progress.transferId];
        const entry = transferEntryFromProgress(progress, prev, this.now());
        this.view.queue = { ...queue, [entry.id]: entry };
        break;
      }
      case "transfer.reconcile": {
        const snapshots = p.snapshots as TransferSnapshot[];
        let next: Record<string, TransferEntry> | null = null;
        for (const snap of snapshots) {
          if (!snap.settled || !isTerminalTransferState(snap.state)) continue;
          const prev = queue[snap.transferId];
          if (!prev || isTerminalTransferState(prev.state)) continue;
          next ??= { ...queue };
          next[snap.transferId] = transferEntryFromSnapshot(snap, prev, this.now());
        }
        if (next) this.view.queue = next;
        break;
      }
      case "transfer.remove": {
        const id = p.id as string;
        if (id in queue) {
          const next = { ...queue };
          delete next[id];
          this.view.queue = next;
        }
        break;
      }
      case "transfer.clearCompleted":
        this.view.queue = Object.fromEntries(
          Object.entries(queue).filter(([, t]) => t.state !== "completed")
        );
        break;
      case "transfer.setMinimized":
        this.view.minimized = p.minimized as boolean;
        break;
      case "transfer.replace":
        this.view = {
          queue: (p.queue as TransfersView["queue"]) ?? {},
          minimized: (p.minimized as boolean) ?? false,
        };
        break;
      default:
        return { intentId: intent.intentId, status: "accepted", produced: [] };
    }
    this.bump();
    return {
      intentId: intent.intentId,
      status: "accepted",
      produced: [{ region: TRANSFERS_REGION, version: this.version }],
    };
  }

  async subscribe(region: string, onFrame: FrameHandler): Promise<Subscription> {
    this.handlers.add(onFrame);
    return {
      snapshot: this.snapshot(region),
      unsubscribe: () => this.handlers.delete(onFrame),
    };
  }

  async resync(): Promise<SnapshotFrame | null> {
    return null;
  }

  private snapshot(region: string): SnapshotFrame {
    return { kind: "snapshot", region, version: this.version, view: structuredClone(this.view) };
  }

  private bump(): void {
    this.version += 1;
    const frame = this.snapshot(TRANSFERS_REGION);
    for (const h of this.handlers) h(frame);
  }
}

/**
 * Install a {@link FakeTransferTransport} as the transfers bridge's transport and
 * optionally seed it. Returns the transport plus a `teardown` that drops the
 * subscription and restores the real transport — call it in `afterEach`.
 */
export function installTransferHarness(initial?: TransfersView): {
  transport: FakeTransferTransport;
  teardown: () => void;
} {
  const transport = new FakeTransferTransport();
  setTransferTransportForTest(transport);
  if (initial) transport.seed(initial);
  return {
    transport,
    teardown: () => {
      stopTransfersSubscription();
      setTransferTransportForTest(null);
    },
  };
}
