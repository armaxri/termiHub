/**
 * Restore-cohort render cut (#2241, part of #2206 / #2139).
 *
 * The render cut fires the aggregate restore/launch summary toast once per new
 * projected settlement `seq` from the `restore-cohort@<clientId>` region, instead
 * of straight from the local reducer — the fired content is the gate-validated
 * local summary, so it is byte-identical to the pre-cut toast.
 *
 * These tests prove:
 * - with the render flag **on** and a live region, the summary fires from the
 *   projection (asynchronously, after the settle round-trips) exactly once;
 * - a dispatch failure falls back to firing the summary locally, so the toast is
 *   never lost (the parity-safe fallback);
 * - with the render flag **off**, the summary fires straight from the local
 *   reducer, synchronously (the pre-cut path).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { flushMacrotask } from "@/test/flushAsync";

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
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
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

/** Subscription-capable twin of the Rust store; `rejectDispatch` forces every
 * intent ack to `rejected` (the transport-down fallback path). */
class RestoreStoreTransport implements Transport {
  rejectDispatch = false;
  private clients = new Map<string, ClientState>();
  private version = 0;
  private handlers = new Map<string, FrameHandler[]>();

  async dispatch(intent: Intent): Promise<IntentAck> {
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
    if (intent.kind === "restore.beginCohort") {
      const raw = (p.pendingTabIds as string[]) ?? [];
      const pending: string[] = [];
      for (const id of raw) if (!pending.includes(id)) pending.push(id);
      const preFailed = (p.preFailedCount as number | undefined) ?? 0;
      const total = pending.length + preFailed;
      if (total === 0) return;
      s.cohort = {
        pending,
        total,
        failed: preFailed,
        failedTabIds: [],
        toastId: (p.toastId as string | undefined) ?? null,
      };
      s.failedTabIds = [];
      if (pending.length === 0) this.settleCohort(intent.clientId);
    } else if (intent.kind === "restore.settleTab") {
      if (!s.cohort) return;
      const tabId = p.tabId as string;
      const pos = s.cohort.pending.indexOf(tabId);
      if (pos < 0) return;
      s.cohort.pending.splice(pos, 1);
      if (p.outcome === "failed") {
        s.cohort.failed += 1;
        if (!s.cohort.failedTabIds.includes(tabId)) s.cohort.failedTabIds.push(tabId);
      }
      if (s.cohort.pending.length === 0) this.settleCohort(intent.clientId);
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

  private regionView(clientId: string) {
    const s = this.state(clientId);
    return structuredClone({
      cohort: s.cohort,
      failedTabIds: s.failedTabIds,
      settlement: s.settlement,
    });
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

/** Let the subscribe/dispatch promise chain settle so projection diffs land. */
async function settleAsync(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await flushMacrotask();
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

setupConnectionsRegion();
setupSettingsRegion();

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
  });
  seedSettings({ restoreLastSessionOnStartup: true });
  seedConnectionsRegion({ connections: [] });
  transport = new RestoreStoreTransport();
  setRestoreTransportForTest(transport);
  setRestoreIntentsEnabled(true);
  setRestoreRenderFromProjectionEnabled(true);
});

afterEach(() => {
  setRestoreTransportForTest(null);
  setRestoreIntentsEnabled(null);
  setRestoreRenderFromProjectionEnabled(null);
});

describe("restore-cohort render cut — summary fires from the projection", () => {
  it("fires the partial summary from the projected settlement, once, asynchronously", async () => {
    mockLoad.mockResolvedValue(threeLocalTabsSession());
    await useAppStore.getState().restoreLastSession();
    const ids = restoredTabIds();

    useAppStore.getState().setTabSessionId(ids[0], "sess-a");
    useAppStore.getState().setTabSessionId(ids[1], "sess-b");
    useAppStore.getState().setTerminalDisconnectWithError(ids[2], "connection refused");

    // Not fired synchronously — the render cut waits for the projected settlement.
    expect(toastInfo).not.toHaveBeenCalled();

    await settleAsync();

    // Exactly one aggregate partial summary, sourced from the projected region.
    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
    const msg = String(toastInfo.mock.calls[0][0]);
    expect(msg).toContain("2");
    expect(msg).toContain("3");
    expect(msg).toContain("1");
    // The bulk-retry action is attached from the projected retry set (live-filtered).
    const opts = toastInfo.mock.calls[0][1] as { action?: { label: string; onClick: () => void } };
    expect(opts?.action?.label).toBe("Reconnect failed tabs");
    expect(useAppStore.getState().failedRestoreTabIds).toEqual([ids[2]]);
  });

  it("fires the success summary from the projection when every tab connects", async () => {
    mockLoad.mockResolvedValue(threeLocalTabsSession());
    await useAppStore.getState().restoreLastSession();
    const ids = restoredTabIds();

    ids.forEach((id, i) => useAppStore.getState().setTabSessionId(id, `sess-${i}`));
    expect(toastSuccess).not.toHaveBeenCalled();

    await settleAsync();

    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastInfo).not.toHaveBeenCalled();
    expect(String(toastSuccess.mock.calls[0][0])).toContain("3");
  });

  it("falls back to firing the summary locally when the dispatch is rejected", async () => {
    transport.rejectDispatch = true;
    mockLoad.mockResolvedValue(threeLocalTabsSession());
    await useAppStore.getState().restoreLastSession();
    const ids = restoredTabIds();

    useAppStore.getState().setTabSessionId(ids[0], "sess-a");
    useAppStore.getState().setTabSessionId(ids[1], "sess-b");
    useAppStore.getState().setTerminalDisconnectWithError(ids[2], "refused");

    await settleAsync();

    // The rejected mirror can never advance the region, so the fallback fires the
    // local summary — exactly once, never lost.
    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().failedRestoreTabIds).toEqual([ids[2]]);
  });
});

describe("restore-cohort render cut — flag off fires locally (pre-cut path)", () => {
  beforeEach(() => setRestoreRenderFromProjectionEnabled(false));

  it("fires the summary synchronously from the local reducer", async () => {
    mockLoad.mockResolvedValue(threeLocalTabsSession());
    await useAppStore.getState().restoreLastSession();
    const ids = restoredTabIds();

    useAppStore.getState().setTabSessionId(ids[0], "sess-a");
    useAppStore.getState().setTabSessionId(ids[1], "sess-b");
    useAppStore.getState().setTerminalDisconnectWithError(ids[2], "refused");

    // Fired synchronously, before any async round-trip.
    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().failedRestoreTabIds).toEqual([ids[2]]);
  });
});
