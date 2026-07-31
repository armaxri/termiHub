/**
 * Transfers mutation cut (#2229, part of #2139 and #2153) — cut-vs-local parity.
 *
 * The mutation cut routes each Transfer Queue action through a granular
 * `transfer.*` intent so the backend `TransferStore` becomes authoritative, while
 * the local `appStore` reducer path stays in place as the render source and the
 * resilience / rollback fallback (the reducer removal is a later step). This is
 * the final Phase-5 domain: with it merged every Phase-5 domain is fully cut over
 * (shadow + render + mutation).
 *
 * These tests prove the cut is parity-safe end to end: with the flag **on**, the
 * intents dispatched by the actions — applied by a faithful in-memory port of the
 * Rust store (mirroring `transfers_projection/store.rs`, itself a twin of the
 * shared `@/types/transfer` fold helpers) — reproduce the exact `appStore`
 * transfer-queue slice (`transferQueue` + `transferQueueMinimized`) for every
 * action and its fan-out. With the flag **off**, no intents are dispatched and the
 * local slice is byte-identical — the instant rollback path the flip relies on.
 *
 * Timekeeping: `updatedAt` on a fold is stamped with `now`. Both the `appStore`
 * reducer and this in-memory port read `Date.now()`, and `mirrorTransferIntent`
 * dispatches synchronously in the same action tick, so a frozen fake clock gives
 * both the same `now` — the region entries are value-identical to `appStore`'s.
 *
 * JSON semantics: a `TransferEntry` carries optional fields (`path` / `error` /
 * `attempt` / `maxAttempts`) that `appStore` may hold as explicit `undefined`
 * keys, whereas the region round-trips through JSON (serde) and drops them. The
 * region view here is JSON-normalised to model that wire behaviour, and `toEqual`
 * treats an absent key and an explicit `undefined` as equal — so a dropped
 * optional key never reads as a parity failure.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  persistConnection: vi.fn(() => Promise.resolve("persisted-id")),
  removeConnection: vi.fn(() => Promise.resolve()),
  persistFolder: vi.fn(() => Promise.resolve()),
  removeFolder: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() =>
    Promise.resolve({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
    })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  moveConnectionToFile: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(() => Promise.resolve()),
  sftpListDir: vi.fn(() => Promise.resolve([])),
  sftpRealpath: vi.fn(() => Promise.resolve("/home/alice")),
  sftpCancelTransfer: vi.fn(() => Promise.resolve()),
  claimSession: vi.fn(() => Promise.resolve(null)),
  releaseSession: vi.fn(() => Promise.resolve(true)),
  listSessionOwners: vi.fn(() => Promise.resolve({})),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
}));

import { useAppStore } from "./appStore";
import { setTransferIntentsEnabled, setTransferTransportForTest } from "./transfersBridge";
import type { TransferProgress, TransferSnapshot } from "@/services/api";
import {
  type TransferEntry,
  type TransferSeed,
  isTerminalTransferState,
  transferEntryFromProgress,
  transferEntryFromSeed,
  transferEntryFromSnapshot,
} from "@/types/transfer";
import type {
  FrameHandler,
  Intent,
  IntentAck,
  ProjectionFrame,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";

// ── Fixtures (twins of appStore.transferQueue.test.ts) ─────────────────────────

function seed(overrides: Partial<TransferSeed> = {}): TransferSeed {
  return {
    id: "t1",
    sessionId: "sess-a",
    direction: "download",
    name: "file.txt",
    path: "/remote/file.txt",
    totalBytes: 100,
    ...overrides,
  };
}

function progress(overrides: Partial<TransferProgress> = {}): TransferProgress {
  return {
    transferId: "t1",
    sessionId: "sess-a",
    direction: "download",
    fileName: "file.txt",
    transferred: 0,
    total: 100,
    phase: "transferring",
    ...overrides,
  };
}

function snapshot(overrides: Partial<TransferSnapshot> = {}): TransferSnapshot {
  return {
    transferId: "t1",
    sessionId: "sess-a",
    direction: "download",
    fileName: "file.txt",
    path: "/remote/file.txt",
    state: "completed",
    settled: true,
    transferred: 100,
    total: 100,
    speed: 0,
    attempt: 0,
    maxAttempts: 3,
    ...overrides,
  };
}

// ── In-memory Rust-store double ────────────────────────────────────────────────

interface RegionView {
  queue: Record<string, TransferEntry>;
  minimized: boolean;
}

/**
 * A substrate double that applies the granular `transfer.*` intents with the same
 * semantics as the Rust `TransferStore` (`transfers_projection/store.rs`), so a
 * run of the real `appStore` actions (which mirror those intents) reconstructs the
 * region view the Transfer Queue panel would render. Only `transfer.replace` (the
 * render-cut mirror) is intentionally not applied — the mutation cut drives the
 * region through the per-transition intents.
 *
 * The fold helpers are the shared `@/types/transfer` twins the Rust store and the
 * `appStore` reducers both use, applied here with `Date.now()` — a frozen fake
 * clock gives the same `now` as the reducer, so the entries match value-for-value.
 */
class TransferStoreTransport implements Transport {
  dispatched: Intent[] = [];
  private queue: Record<string, TransferEntry> = {};
  private minimized = false;
  private version = 0;
  private handlers: FrameHandler[] = [];

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    this.apply(intent);
    this.version += 1;
    this.fan();
    return {
      intentId: intent.intentId,
      status: "accepted",
      produced: [{ region: "transfers", version: this.version }],
    };
  }

  private apply(intent: Intent): void {
    const p = intent.payload as Record<string, unknown>;
    const now = Date.now();
    switch (intent.kind) {
      case "transfer.seed": {
        const s = p.seed as TransferSeed;
        // Idempotent: never overwrite a row an event already advanced.
        if (this.queue[s.id]) break;
        this.queue[s.id] = transferEntryFromSeed(s, now);
        break;
      }
      case "transfer.progress": {
        const prog = p.progress as TransferProgress;
        const prev = this.queue[prog.transferId];
        const entry = transferEntryFromProgress(prog, prev, now);
        this.queue[entry.id] = entry;
        break;
      }
      case "transfer.reconcile": {
        const snaps = p.snapshots as TransferSnapshot[];
        for (const snap of snaps) {
          if (!snap.settled || !isTerminalTransferState(snap.state)) continue;
          const prev = this.queue[snap.transferId];
          if (!prev) continue;
          if (isTerminalTransferState(prev.state)) continue;
          this.queue[snap.transferId] = transferEntryFromSnapshot(snap, prev, now);
        }
        break;
      }
      case "transfer.remove": {
        delete this.queue[p.id as string];
        break;
      }
      case "transfer.clearCompleted": {
        this.queue = Object.fromEntries(
          Object.entries(this.queue).filter(([, e]) => e.state !== "completed")
        );
        break;
      }
      case "transfer.setMinimized": {
        this.minimized = p.minimized as boolean;
        break;
      }
      default:
        break;
    }
  }

  /**
   * The reconstructed region view, twin of the store snapshot. JSON-normalised to
   * model the serde round-trip that drops explicit `undefined` optional keys.
   */
  regionView(): RegionView {
    return JSON.parse(JSON.stringify({ queue: this.queue, minimized: this.minimized }));
  }

  kinds(): string[] {
    return this.dispatched.map((i) => i.kind);
  }

  async subscribe(region: string, onFrame: FrameHandler): Promise<Subscription> {
    this.handlers.push(onFrame);
    return {
      snapshot: this.snapshot(region),
      unsubscribe: () => {
        this.handlers = this.handlers.filter((h) => h !== onFrame);
      },
    };
  }

  async resync(): Promise<SnapshotFrame | null> {
    return null;
  }

  private snapshot(region: string): SnapshotFrame {
    return { kind: "snapshot", region, version: this.version, view: this.regionView() };
  }

  private fan(): void {
    const frame: ProjectionFrame = this.snapshot("transfers");
    for (const h of this.handlers) h(frame);
  }
}

let transport: TransferStoreTransport;

/** Assert the region the intents reconstruct equals the local appStore slice. */
function expectParity() {
  const state = useAppStore.getState();
  const region = transport.regionView();
  expect(region.queue).toEqual(state.transferQueue);
  expect(region.minimized).toEqual(state.transferQueueMinimized);
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  transport = new TransferStoreTransport();
  setTransferTransportForTest(transport);
  setTransferIntentsEnabled(true);
});

afterEach(() => {
  setTransferTransportForTest(null);
  setTransferIntentsEnabled(null);
  vi.useRealTimers();
});

describe("transfers mutation cut — cut-vs-local parity (flag on)", () => {
  it("seedTransferQueue enqueues a queued row in the region", () => {
    useAppStore.getState().seedTransferQueue(seed());

    expect(transport.kinds()).toEqual(["transfer.seed"]);
    expectParity();
    expect(transport.regionView().queue["t1"].state).toBe("queued");
  });

  it("seedTransferQueue is idempotent — a second seed does not overwrite the row", () => {
    useAppStore.getState().seedTransferQueue(seed());
    useAppStore
      .getState()
      .applyTransferProgressToQueue(progress({ transferred: 50, state: "active" }));
    // Re-seeding the same id must not clobber the further-along row.
    useAppStore.getState().seedTransferQueue(seed());

    expectParity();
    expect(transport.regionView().queue["t1"].transferred).toBe(50);
  });

  it("applyTransferProgressToQueue folds a progress event into the region", () => {
    useAppStore.getState().seedTransferQueue(seed());
    useAppStore
      .getState()
      .applyTransferProgressToQueue(progress({ transferred: 40, state: "active" }));

    expect(transport.kinds()).toEqual(["transfer.seed", "transfer.progress"]);
    expectParity();
    const row = transport.regionView().queue["t1"];
    expect(row.state).toBe("active");
    expect(row.transferred).toBe(40);
    expect(row.percent).toBe(40);
  });

  it("applyTransferProgressToQueue upserts a row with no prior seed", () => {
    useAppStore
      .getState()
      .applyTransferProgressToQueue(progress({ transferred: 100, state: "completed" }));

    expect(transport.kinds()).toEqual(["transfer.progress"]);
    expectParity();
    expect(transport.regionView().queue["t1"].state).toBe("completed");
    expect(transport.regionView().queue["t1"].percent).toBe(100);
  });

  it("computed throughput across two progress events stays in parity", () => {
    useAppStore
      .getState()
      .applyTransferProgressToQueue(progress({ transferred: 10, state: "active", speed: 0 }));
    vi.advanceTimersByTime(1000);
    useAppStore
      .getState()
      .applyTransferProgressToQueue(progress({ transferred: 60, state: "active", speed: 0 }));

    expectParity();
    // 50 bytes over 1000ms → 50 B/s, computed identically both sides.
    expect(transport.regionView().queue["t1"].speedBytesPerSec).toBe(50);
  });

  it("applyTransferProgressToQueue does NOT dispatch for a session owned by another window", () => {
    // A session the backend map assigns to a different window is suppressed by
    // the reducer; the mutation cut must not advance the shared region past it.
    useAppStore.setState({
      sessionOwners: { "sess-a": "other-window" },
      windowLabel: "main",
    });

    useAppStore
      .getState()
      .applyTransferProgressToQueue(progress({ transferred: 40, state: "active" }));

    expect(transport.kinds()).toEqual([]);
    expectParity();
    expect(transport.regionView().queue).toEqual({});
  });

  it("reconcileTransferQueue settles a stuck row from a terminal snapshot", () => {
    useAppStore.getState().seedTransferQueue(seed());
    useAppStore
      .getState()
      .applyTransferProgressToQueue(progress({ transferred: 60, state: "active" }));

    useAppStore.getState().reconcileTransferQueue([snapshot({ state: "completed" })]);

    expect(transport.kinds()).toEqual(["transfer.seed", "transfer.progress", "transfer.reconcile"]);
    expectParity();
    expect(transport.regionView().queue["t1"].state).toBe("completed");
  });

  it("reconcileTransferQueue never resurrects a removed row", () => {
    useAppStore.getState().seedTransferQueue(seed());
    useAppStore.getState().removeTransfer("t1");

    useAppStore.getState().reconcileTransferQueue([snapshot({ state: "completed" })]);

    expectParity();
    expect(transport.regionView().queue["t1"]).toBeUndefined();
  });

  it("removeTransfer drops the row from the region", () => {
    useAppStore.getState().seedTransferQueue(seed({ id: "t1" }));
    useAppStore.getState().seedTransferQueue(seed({ id: "t2" }));

    useAppStore.getState().removeTransfer("t1");

    expect(transport.kinds()).toEqual(["transfer.seed", "transfer.seed", "transfer.remove"]);
    expectParity();
    expect(Object.keys(transport.regionView().queue)).toEqual(["t2"]);
  });

  it("clearCompleted removes only completed rows in the region", () => {
    useAppStore.getState().seedTransferQueue(seed({ id: "done" }));
    useAppStore
      .getState()
      .applyTransferProgressToQueue(
        progress({ transferId: "done", transferred: 100, state: "completed" })
      );
    useAppStore.getState().seedTransferQueue(seed({ id: "live" }));
    useAppStore
      .getState()
      .applyTransferProgressToQueue(
        progress({ transferId: "live", transferred: 20, state: "active" })
      );

    useAppStore.getState().clearCompleted();

    expect(transport.kinds()).toContain("transfer.clearCompleted");
    expectParity();
    const keys = Object.keys(transport.regionView().queue);
    expect(keys).toEqual(["live"]);
  });

  it("setTransferQueueMinimized mirrors the panel flag", () => {
    useAppStore.getState().setTransferQueueMinimized(true);

    expect(transport.kinds()).toEqual(["transfer.setMinimized"]);
    expectParity();
    expect(transport.regionView().minimized).toBe(true);

    useAppStore.getState().setTransferQueueMinimized(false);
    expectParity();
    expect(transport.regionView().minimized).toBe(false);
  });

  it("a full lifecycle fan-out reconstructs the exact slice", () => {
    const s = useAppStore.getState();
    s.seedTransferQueue(seed({ id: "a" }));
    s.seedTransferQueue(seed({ id: "b" }));
    s.applyTransferProgressToQueue(progress({ transferId: "a", transferred: 50, state: "active" }));
    s.applyTransferProgressToQueue(
      progress({ transferId: "b", transferred: 100, state: "completed" })
    );
    s.setTransferQueueMinimized(true);
    s.clearCompleted();
    s.removeTransfer("a");

    expectParity();
    expect(transport.regionView().queue).toEqual({});
    expect(transport.regionView().minimized).toBe(true);
  });
});

describe("transfers mutation cut — flag off is the local-only rollback path", () => {
  beforeEach(() => {
    setTransferIntentsEnabled(false);
  });

  it("dispatches nothing when the flag is off", () => {
    const s = useAppStore.getState();
    s.seedTransferQueue(seed());
    s.applyTransferProgressToQueue(progress({ transferred: 50, state: "active" }));
    s.reconcileTransferQueue([snapshot({ state: "completed" })]);
    s.setTransferQueueMinimized(true);
    s.clearCompleted();
    s.removeTransfer("t1");

    expect(transport.dispatched).toEqual([]);
    // The local slice still mutates exactly as before the cut.
    expect(useAppStore.getState().transferQueueMinimized).toBe(true);
    expect(useAppStore.getState().transferQueue).toEqual({});
  });
});
