/**
 * Restore-cohort mutation cut (#2241, part of #2206 / #2139) — cut-vs-local parity.
 *
 * The mutation cut routes `beginRestoreCohort` / `settleRestoreTab` through the
 * `restore.beginCohort` / `restore.settleTab` intents so the backend
 * `RestoreCohortStore` becomes authoritative, while the local `appStore` cohort
 * reducers stay in place as the render source and the resilience / rollback
 * fallback (removal is a later step).
 *
 * These tests prove the cut is parity-safe: with the intents flag **on**, the
 * intents dispatched by the actions — applied by a faithful in-memory port of the
 * Rust store (mirroring `restore_cohort_projection/store.rs`) — reconstruct the
 * `restore-cohort@<clientId>` region whose settled summary + captured failed-tab
 * set match the local slice. With the flag **off**, no intents are dispatched — the
 * instant rollback path the flip relies on.
 *
 * The render flag is held **off** here so the summary toast fires straight from the
 * local reducer (isolating the mutation cut); the render cut is covered separately
 * in `restoreCohortBridge.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const toastSuccess = vi.fn((_m: unknown, _o?: unknown) => undefined);
const toastError = vi.fn((_m: unknown, _o?: unknown) => undefined);
const toastInfo = vi.fn((_m: unknown, _o?: unknown) => undefined);
vi.mock("@/components/ui", () => ({
  toast: {
    success: (m: unknown, o?: unknown) => (o === undefined ? toastSuccess(m) : toastSuccess(m, o)),
    error: (m: unknown, o?: unknown) => (o === undefined ? toastError(m) : toastError(m, o)),
    info: (m: unknown, o?: unknown) => (o === undefined ? toastInfo(m) : toastInfo(m, o)),
    loading: vi.fn(() => "toast-id"),
    dismiss: vi.fn(),
  },
}));

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  persistConnection: vi.fn(() => Promise.resolve()),
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
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  closeTerminal: vi.fn(() => Promise.resolve()),
  detachPersistentTab: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/services/lastSessionApi", () => ({
  saveLastSession: vi.fn(() => Promise.resolve()),
  loadLastSession: vi.fn(() => Promise.resolve(null)),
  clearLastSession: vi.fn(() => Promise.resolve()),
}));

import { useAppStore } from "./appStore";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import {
  setRestoreIntentsEnabled,
  setRestoreRenderFromProjectionEnabled,
  setRestoreTransportForTest,
} from "./restoreCohortBridge";
import { loadLastSession } from "@/services/lastSessionApi";
import { getAllLeaves } from "@/utils/panelTree";
import type { LastSession } from "@/types/lastSession";
import type {
  FrameHandler,
  Intent,
  IntentAck,
  ProjectionFrame,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";

const mockLoad = vi.mocked(loadLastSession);

// ── In-memory twin of the Rust RestoreCohortStore (client-scoped) ──────────────

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
interface RegionView {
  cohort: (Omit<Cohort, "toastId"> & { toastId: string | null }) | null;
  failedTabIds: string[];
  settlement: Settlement | null;
}

/** A transport double that applies `restore.*` intents with the same semantics as
 * the Rust `RestoreCohortStore`, keyed by `clientId`, and fans the client's region
 * snapshot to subscribers on every mutation. */
class RestoreStoreTransport implements Transport {
  dispatched: Intent[] = [];
  private clients = new Map<string, ClientState>();
  private version = 0;
  private handlers = new Map<string, FrameHandler[]>();

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    this.apply(intent);
    this.version += 1;
    this.fan(intent.clientId);
    return {
      intentId: intent.intentId,
      status: "accepted",
      produced: [{ region: this.region(intent.clientId), version: this.version }],
    };
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

  regionView(clientId: string): RegionView {
    const s = this.state(clientId);
    return structuredClone({
      cohort: s.cohort
        ? {
            pending: s.cohort.pending,
            total: s.cohort.total,
            failed: s.cohort.failed,
            failedTabIds: s.cohort.failedTabIds,
            toastId: s.cohort.toastId,
          }
        : null,
      failedTabIds: s.failedTabIds,
      settlement: s.settlement,
    });
  }

  /** The single client's region view (there is one per-session client id). */
  onlyRegionView(): RegionView {
    const [clientId] = [...this.clients.keys()];
    return this.regionView(clientId ?? "");
  }

  kinds(): string[] {
    return this.dispatched.map((i) => i.kind);
  }

  private region(clientId: string): string {
    return `restore-cohort@${clientId}`;
  }

  async subscribe(region: string, onFrame: FrameHandler): Promise<Subscription> {
    const list = this.handlers.get(region) ?? [];
    list.push(onFrame);
    this.handlers.set(region, list);
    const clientId = region.slice("restore-cohort@".length);
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

let transport: RestoreStoreTransport;

/** A three-tab session that all resolve to plain local terminals. */
function threeLocalTabsSession(): LastSession {
  return {
    version: "1",
    activeGroupIndex: 0,
    tabGroups: [
      {
        name: "Restored",
        layout: {
          type: "leaf",
          tabs: [
            { inlineConfig: { type: "local", config: { shell: "bash" } }, title: "Shell A" },
            { inlineConfig: { type: "local", config: { shell: "bash" } }, title: "Shell B" },
            { inlineConfig: { type: "local", config: { shell: "bash" } }, title: "Shell C" },
          ],
        },
      },
    ],
  };
}

function restoredTabIds(): string[] {
  return getAllLeaves(useAppStore.getState().rootPanel)
    .flatMap((l) => l.tabs)
    .map((t) => t.id);
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

setupConnectionsRegion();

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
  mockLoad.mockResolvedValue(null);
  useAppStore.setState({
    remoteAgents: [],
    agentDefinitions: {},
    defaultShell: "bash",
    restoreCohort: null,
    failedRestoreTabIds: [],
    settings: { ...useAppStore.getState().settings, restoreLastSessionOnStartup: true },
  });
  seedConnectionsRegion({ connections: [] });
  transport = new RestoreStoreTransport();
  setRestoreTransportForTest(transport);
  setRestoreIntentsEnabled(true);
  // Isolate the mutation cut: the summary toast fires straight from the local
  // reducer here (the render cut is covered separately).
  setRestoreRenderFromProjectionEnabled(false);
});

afterEach(() => {
  setRestoreTransportForTest(null);
  setRestoreIntentsEnabled(null);
  setRestoreRenderFromProjectionEnabled(null);
});

describe("restore-cohort mutation cut — cut-vs-local parity (intents on)", () => {
  it("a partial restore reproduces the settled region + captured failed set", async () => {
    mockLoad.mockResolvedValue(threeLocalTabsSession());
    await useAppStore.getState().restoreLastSession();
    const ids = restoredTabIds();
    expect(ids).toHaveLength(3);

    useAppStore.getState().setTabSessionId(ids[0], "sess-a");
    useAppStore.getState().setTabSessionId(ids[1], "sess-b");
    useAppStore.getState().setTerminalDisconnectWithError(ids[2], "connection refused");
    await flush();

    // The intent stream: one begin, then one settle per tab.
    expect(transport.kinds()).toEqual([
      "restore.beginCohort",
      "restore.settleTab",
      "restore.settleTab",
      "restore.settleTab",
    ]);

    const region = transport.onlyRegionView();
    // The cohort settled and the summary matches the local computation.
    expect(region.cohort).toBeNull();
    expect(region.settlement).toMatchObject({ total: 3, restored: 2, failed: 1 });
    expect(region.settlement?.retryTabIds).toEqual([ids[2]]);
    // The captured failed set matches the local slice (all failed tabs are live).
    expect(region.failedTabIds).toEqual(useAppStore.getState().failedRestoreTabIds);
    expect(useAppStore.getState().failedRestoreTabIds).toEqual([ids[2]]);
  });

  it("a full success reproduces a zero-failure settlement", async () => {
    mockLoad.mockResolvedValue(threeLocalTabsSession());
    await useAppStore.getState().restoreLastSession();
    const ids = restoredTabIds();

    ids.forEach((id, i) => useAppStore.getState().setTabSessionId(id, `sess-${i}`));
    await flush();

    const region = transport.onlyRegionView();
    expect(region.settlement).toMatchObject({ total: 3, restored: 3, failed: 0 });
    expect(region.settlement?.retryTabIds).toEqual([]);
    expect(region.failedTabIds).toEqual([]);
    expect(useAppStore.getState().failedRestoreTabIds).toEqual([]);
  });

  it("mirrors the in-flight cohort before it settles", async () => {
    mockLoad.mockResolvedValue(threeLocalTabsSession());
    await useAppStore.getState().restoreLastSession();
    const ids = restoredTabIds();

    // Settle only one tab — the cohort is still in flight.
    useAppStore.getState().setTabSessionId(ids[0], "sess-a");
    await flush();

    const region = transport.onlyRegionView();
    expect(region.settlement).toBeNull();
    expect(region.cohort).not.toBeNull();
    // The projected in-flight cohort mirrors the local one.
    const local = useAppStore.getState().restoreCohort;
    expect(region.cohort?.total).toBe(local?.total);
    expect(new Set(region.cohort?.pending)).toEqual(local?.pending);
    expect(region.cohort?.failed).toBe(local?.failed);
  });

  it("bulk-retry reconnect dispatches a fresh cohort + settle", async () => {
    mockLoad.mockResolvedValue(threeLocalTabsSession());
    await useAppStore.getState().restoreLastSession();
    const ids = restoredTabIds();
    useAppStore.getState().setTabSessionId(ids[0], "sess-a");
    useAppStore.getState().setTabSessionId(ids[1], "sess-b");
    useAppStore.getState().setTerminalDisconnectWithError(ids[2], "refused");
    await flush();
    const before = transport.dispatched.length;

    useAppStore.getState().reconnectFailedRestoreTabs();
    useAppStore.getState().setTabSessionId(ids[2], "sess-c-retry");
    await flush();

    // A fresh beginCohort covering the retried tab, then its settle.
    expect(transport.kinds().slice(before)).toEqual(["restore.beginCohort", "restore.settleTab"]);
    const region = transport.onlyRegionView();
    expect(region.settlement).toMatchObject({ total: 1, restored: 1, failed: 0 });
    expect(region.failedTabIds).toEqual([]);
    expect(useAppStore.getState().failedRestoreTabIds).toEqual([]);
  });

  it("a stray settle for a non-pending tab dispatches nothing", async () => {
    mockLoad.mockResolvedValue(threeLocalTabsSession());
    await useAppStore.getState().restoreLastSession();
    const ids = restoredTabIds();
    ids.forEach((id, i) => useAppStore.getState().setTabSessionId(id, `sess-${i}`));
    await flush();
    const before = transport.dispatched.length;

    // The cohort has settled — a later settle on the same tab is a no-op locally
    // and dispatches nothing (mirrors the store ignoring a non-pending settle).
    useAppStore.getState().setTerminalDisconnectWithError(ids[0], "later drop");
    await flush();
    expect(transport.dispatched.length).toBe(before);
  });
});

describe("restore-cohort mutation cut — flags off (rollback path)", () => {
  beforeEach(() => {
    setRestoreIntentsEnabled(false);
    setRestoreRenderFromProjectionEnabled(false);
  });

  it("dispatches no intents and drives the cohort locally", async () => {
    mockLoad.mockResolvedValue(threeLocalTabsSession());
    await useAppStore.getState().restoreLastSession();
    const ids = restoredTabIds();
    useAppStore.getState().setTabSessionId(ids[0], "sess-a");
    useAppStore.getState().setTabSessionId(ids[1], "sess-b");
    useAppStore.getState().setTerminalDisconnectWithError(ids[2], "refused");
    await flush();

    // No mirror reached the region — the pre-cut local path is intact.
    expect(transport.dispatched).toHaveLength(0);
    expect(useAppStore.getState().failedRestoreTabIds).toEqual([ids[2]]);
    expect(useAppStore.getState().restoreCohort).toBeNull();
  });
});
