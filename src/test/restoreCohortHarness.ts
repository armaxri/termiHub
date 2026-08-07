/**
 * Test harness for the region-authoritative restore-cohort domain (#2206).
 *
 * Since the reducer removal, the `restore-cohort@<clientId>` region owns the whole
 * aggregate restore/launch feedback machine (#1146 / #1227): the in-flight cohort,
 * the captured failed-tab set, and the monotonic settlement summary. `appStore`
 * holds no cohort slice — its `beginRestoreCohort` / `settleRestoreTab` actions
 * dispatch `restore.*` intents, and the summary toast fires from the projected
 * settlement diff. Tests therefore drive the cohort through those actions and let
 * the region fold and fan the result back.
 *
 * {@link FakeRestoreCohortTransport} is an in-memory twin of the Rust
 * `RestoreCohortStore` that folds `restore.beginCohort` / `restore.settleTab` with
 * the same semantics (dedupe, no-live immediate settle, stray-settle ignore,
 * monotonic settlement `seq`) and fans a client-scoped snapshot to subscribers on
 * every mutation. Dispatch resolves on a microtask so the projected settlement (and
 * its toast) lands asynchronously, exactly like the real IPC round-trip.
 *
 * {@link setupRestoreCohortRegion} installs a fresh transport per test and returns
 * accessors for the live transport plus a {@link RestoreCohortHandle.flush} that
 * drains the dispatch → fan → render chain.
 */

import { afterEach, beforeEach } from "vitest";

import { flushMacrotask } from "@/test/flushAsync";
import { setRestoreTransportForTest, stopRestoreSubscription } from "@/store/restoreCohortBridge";
import type {
  FrameHandler,
  Intent,
  IntentAck,
  ProjectionFrame,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";

const REGION_PREFIX = "restore-cohort@";

interface Cohort {
  pending: string[];
  total: number;
  failed: number;
  failedTabIds: string[];
  toastId: string | null;
}

interface Settlement {
  seq: number;
  total: number;
  restored: number;
  failed: number;
  retryTabIds: string[];
  toastId: string | null;
}

interface ClientState {
  cohort: Cohort | null;
  failedTabIds: string[];
  settlement: Settlement | null;
  settleSeq: number;
}

/** The region snapshot the Rust `ClientState::to_view` serialises. */
export interface RestoreCohortRegionView {
  cohort: Cohort | null;
  failedTabIds: string[];
  settlement: Settlement | null;
}

/**
 * An in-memory substrate double for the client-scoped restore-cohort region,
 * folding `restore.*` intents like the Rust `RestoreCohortStore` and fanning a
 * client snapshot on every mutation. Faithful to the store's semantics so a
 * client-dispatched begin/settle round-trips back into the projected view exactly
 * as it would in production.
 */
export class FakeRestoreCohortTransport implements Transport {
  /** Every intent dispatched, in order (assertion helper). */
  dispatched: Intent[] = [];
  /** Force every dispatch ack to `rejected` (the transport-down path). */
  rejectDispatch = false;
  private clients = new Map<string, ClientState>();
  private version = 0;
  private handlers = new Map<string, FrameHandler[]>();

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    // Real IPC round-trips asynchronously — yield before applying/fanning so the
    // projected settlement (and its toast) never lands synchronously.
    await Promise.resolve();
    if (this.rejectDispatch) {
      return {
        intentId: intent.intentId,
        status: "rejected",
        error: { code: "unavailable", message: "store down" },
      };
    }
    this.apply(intent);
    this.version += 1;
    this.fan(intent.clientId);
    return {
      intentId: intent.intentId,
      status: "accepted",
      produced: [{ region: this.region(intent.clientId), version: this.version }],
    };
  }

  /** Intent kinds dispatched, in order (assertion helper). */
  kinds(): string[] {
    return this.dispatched.map((i) => i.kind);
  }

  /** The single per-session client's region view (there is one client id). */
  onlyRegionView(): RestoreCohortRegionView {
    const [id] = [...this.clients.keys()];
    return this.regionView(id ?? "");
  }

  private state(clientId: string): ClientState {
    let s = this.clients.get(clientId);
    if (!s) {
      s = { cohort: null, failedTabIds: [], settlement: null, settleSeq: 0 };
      this.clients.set(clientId, s);
    }
    return s;
  }

  private apply(intent: Intent): void {
    const p = intent.payload as Record<string, unknown>;
    const s = this.state(intent.clientId);
    switch (intent.kind) {
      case "restore.beginCohort": {
        const raw = (p.pendingTabIds as string[]) ?? [];
        const pending: string[] = [];
        for (const id of raw) if (!pending.includes(id)) pending.push(id);
        const preFailed = (p.preFailedCount as number | undefined) ?? 0;
        const total = pending.length + preFailed;
        if (total === 0) break;
        s.cohort = {
          pending,
          total,
          failed: preFailed,
          failedTabIds: [],
          toastId: (p.toastId as string | undefined) ?? null,
        };
        s.failedTabIds = [];
        if (pending.length === 0) this.settleCohort(intent.clientId);
        break;
      }
      case "restore.settleTab": {
        if (!s.cohort) break;
        const tabId = p.tabId as string;
        const pos = s.cohort.pending.indexOf(tabId);
        if (pos < 0) break;
        s.cohort.pending.splice(pos, 1);
        if (p.outcome === "failed") {
          s.cohort.failed += 1;
          if (!s.cohort.failedTabIds.includes(tabId)) s.cohort.failedTabIds.push(tabId);
        }
        if (s.cohort.pending.length === 0) this.settleCohort(intent.clientId);
        break;
      }
      default:
        break;
    }
  }

  private settleCohort(clientId: string): void {
    const s = this.state(clientId);
    const cohort = s.cohort;
    if (!cohort) return;
    s.cohort = null;
    s.failedTabIds = [...cohort.failedTabIds];
    s.settleSeq += 1;
    s.settlement = {
      seq: s.settleSeq,
      total: cohort.total,
      restored: cohort.total - cohort.failed,
      failed: cohort.failed,
      retryTabIds: [...cohort.failedTabIds],
      toastId: cohort.toastId,
    };
  }

  private regionView(clientId: string): RestoreCohortRegionView {
    const s = this.state(clientId);
    return structuredClone({
      cohort: s.cohort,
      failedTabIds: s.failedTabIds,
      settlement: s.settlement,
    });
  }

  private region(clientId: string): string {
    return `${REGION_PREFIX}${clientId}`;
  }

  async subscribe(region: string, onFrame: FrameHandler): Promise<Subscription> {
    const list = this.handlers.get(region) ?? [];
    list.push(onFrame);
    this.handlers.set(region, list);
    const clientId = region.slice(REGION_PREFIX.length);
    return {
      snapshot: this.snapshot(region, clientId),
      unsubscribe: () => {
        this.handlers.set(
          region,
          (this.handlers.get(region) ?? []).filter((h) => h !== onFrame)
        );
      },
    };
  }

  async resync(): Promise<SnapshotFrame | null> {
    return null;
  }

  private snapshot(region: string, clientId: string): SnapshotFrame {
    return { kind: "snapshot", region, version: this.version, view: this.regionView(clientId) };
  }

  private fan(clientId: string): void {
    const region = this.region(clientId);
    const frame: ProjectionFrame = this.snapshot(region, clientId);
    for (const h of this.handlers.get(region) ?? []) h(frame);
  }
}

/** Drain the dispatch → fan → onChange → render chain so projection diffs (and the
 * settlement toast) land. Microtasks bracket a single macrotask to cover the async
 * dispatch and the ProjectionClient's own scheduling. */
export async function flushRestore(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await flushMacrotask();
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

/** Accessors returned by {@link setupRestoreCohortRegion}. */
export interface RestoreCohortHandle {
  /** The transport installed for the current test. */
  transport: () => FakeRestoreCohortTransport;
  /** Drain the dispatch → fan → render chain (alias of {@link flushRestore}). */
  flush: () => Promise<void>;
}

/**
 * Install a fresh {@link FakeRestoreCohortTransport} into the restore-cohort bridge
 * for each test (before-each), and drop the subscription after each. Call at the
 * top of a test module; use the returned {@link RestoreCohortHandle.transport} to
 * inspect dispatched intents / the projected region, and
 * {@link RestoreCohortHandle.flush} to await settlement.
 */
export function setupRestoreCohortRegion(): RestoreCohortHandle {
  let current: FakeRestoreCohortTransport;
  beforeEach(() => {
    current = new FakeRestoreCohortTransport();
    setRestoreTransportForTest(current);
  });
  afterEach(() => {
    stopRestoreSubscription();
    setRestoreTransportForTest(null);
  });
  return { transport: () => current, flush: flushRestore };
}
