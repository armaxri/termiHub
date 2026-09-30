/**
 * The projection bridges' failure and fallback paths (#3992).
 *
 * The agents, broadcast, system-monitor, transfers and settings bridges share one
 * shape: a lazily-built transport, a de-duplicated `ensure*Subscribed()`, a
 * fan-out to view listeners, and a best-effort intent dispatch that must never
 * throw out of a UI action. The happy paths are covered next to each bridge; this
 * file covers what happens when things go wrong, table-driven over the real
 * bridges with a scripted transport:
 *
 * - concurrent `ensure*Subscribed()` callers share one subscription;
 * - a failed subscribe is logged, rethrown, and does not latch — a retry
 *   subscribes again;
 * - a throwing view listener is isolated (logged) and does not starve the others;
 * - a best-effort dispatch swallows a rejected ack (with and without a message),
 *   a rejected dispatch promise, and a synchronous transport-construction failure.
 *
 * Per-bridge blocks then cover how a partial or empty region snapshot is
 * normalized into a complete view, and the reliable `seed*Region` mirrors' error
 * mapping.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  FrameHandler,
  Intent,
  IntentAck,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";
import type { AppSettings } from "@/types/connection";
import type { LogEntry } from "@/types/terminal";
import { onFrontendLog } from "@/utils/frontendLog";

import {
  currentAgentsView,
  EMPTY_AGENTS_VIEW,
  ensureAgentsSubscribed,
  mirrorAgentIntent,
  onAgentsView,
  seedAgentsRegion,
  setAgentTransportForTest,
  stopAgentsSubscription,
} from "./agentsBridge";
import {
  currentBroadcastView,
  dispatchBroadcastIntentBestEffort,
  EMPTY_BROADCAST_VIEW,
  ensureBroadcastSubscribed,
  onBroadcastView,
  setBroadcastTransportForTest,
  stopBroadcastSubscription,
} from "./broadcastBridge";
import {
  currentSettingsView,
  DEFAULT_SETTINGS_VIEW,
  ensureSettingsSubscribed,
  mirrorSettingsIntent,
  onSettingsView,
  seedSettingsRegion,
  setSettingsTransportForTest,
  stopSettingsSubscription,
} from "./settingsBridge";
import {
  currentMonitorsView,
  dispatchMonitorIntentBestEffort,
  ensureMonitorsSubscribed,
  onMonitorsView,
  setMonitorTransportForTest,
  stopMonitorsSubscription,
} from "./systemMonitorBridge";
import {
  currentTransfersView,
  dispatchTransferIntentBestEffort,
  ensureTransfersSubscribed,
  onTransfersView,
  setTransferTransportForTest,
  stopTransfersSubscription,
} from "./transfersBridge";

/** How the scripted transport answers a dispatch. */
type DispatchMode =
  | { kind: "ack"; ack: Omit<IntentAck, "intentId"> }
  | { kind: "reject"; error: unknown }
  | { kind: "throw"; error: unknown };

/**
 * A transport double scripted per test: `subscribe` resolves with a snapshot of
 * `view` (or rejects while `failSubscribes` > 0), later frames are pushed with
 * {@link push}, and `dispatch` answers per {@link dispatchMode}.
 */
class ScriptedTransport implements Transport {
  subscribeCalls = 0;
  failSubscribes = 0;
  dispatched: Intent[] = [];
  dispatchMode: DispatchMode = { kind: "ack", ack: { status: "accepted", produced: [] } };
  private handlers: Array<{ region: string; onFrame: FrameHandler }> = [];

  constructor(private view: unknown = undefined) {}

  dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    const mode = this.dispatchMode;
    if (mode.kind === "throw") throw mode.error;
    if (mode.kind === "reject") return Promise.reject(mode.error);
    return Promise.resolve({ intentId: intent.intentId, ...mode.ack });
  }

  async subscribe(region: string, onFrame: FrameHandler): Promise<Subscription> {
    this.subscribeCalls += 1;
    // Yield once so concurrent `ensure*` callers overlap the pending start.
    await Promise.resolve();
    if (this.failSubscribes > 0) {
      this.failSubscribes -= 1;
      throw new Error("subscribe refused");
    }
    this.handlers.push({ region, onFrame });
    return {
      snapshot: { kind: "snapshot", region, version: 1, view: this.view },
      unsubscribe: () => {},
    };
  }

  async resync(): Promise<SnapshotFrame | null> {
    return null;
  }

  /** Push a later snapshot frame (a region diff) to every subscriber. */
  push(view: unknown, version: number): void {
    this.view = view;
    for (const { region, onFrame } of this.handlers) {
      onFrame({ kind: "snapshot", region, version, view });
    }
  }
}

interface BridgeCase {
  name: string;
  setTransport: (t: Transport | null) => void;
  stop: () => void;
  ensure: () => Promise<unknown>;
  onView: (listener: (view: unknown) => void) => () => void;
  current: () => unknown;
  /** The best-effort dispatch the UI actions use. */
  fire: (payload: Record<string, unknown>) => void;
  kind: string;
  /** The frontendLog target the bridge writes to. */
  target: string;
  /** A raw region snapshot that yields a non-baseline view. */
  sample: (n: number) => unknown;
}

const settingsDoc = (n: number): Record<string, unknown> => ({
  ...DEFAULT_SETTINGS_VIEW,
  version: `v${n}`,
});

const CASES: BridgeCase[] = [
  {
    name: "agentsBridge",
    setTransport: setAgentTransportForTest,
    stop: stopAgentsSubscription,
    ensure: ensureAgentsSubscribed,
    onView: onAgentsView as BridgeCase["onView"],
    current: currentAgentsView,
    fire: (p) => mirrorAgentIntent("agent.refresh", p),
    kind: "agent.refresh",
    target: "agent_bridge",
    sample: (n) => ({ agents: [{ id: `a${n}` }] }),
  },
  {
    name: "broadcastBridge",
    setTransport: setBroadcastTransportForTest,
    stop: stopBroadcastSubscription,
    ensure: ensureBroadcastSubscribed,
    onView: onBroadcastView as BridgeCase["onView"],
    current: currentBroadcastView,
    fire: (p) => dispatchBroadcastIntentBestEffort("broadcast.stop", p),
    kind: "broadcast.stop",
    target: "broadcast_bridge",
    sample: (n) => ({ active: true, sourceTabId: `t${n}` }),
  },
  {
    name: "systemMonitorBridge",
    setTransport: setMonitorTransportForTest,
    stop: stopMonitorsSubscription,
    ensure: ensureMonitorsSubscribed,
    onView: onMonitorsView as BridgeCase["onView"],
    current: currentMonitorsView,
    fire: (p) => dispatchMonitorIntentBestEffort("monitor.clearError", p),
    kind: "monitor.clearError",
    target: "monitor_bridge",
    sample: (n) => ({ monitors: { [`m${n}`]: {} } }),
  },
  {
    name: "transfersBridge",
    setTransport: setTransferTransportForTest,
    stop: stopTransfersSubscription,
    ensure: ensureTransfersSubscribed,
    onView: onTransfersView as BridgeCase["onView"],
    current: currentTransfersView,
    fire: (p) => dispatchTransferIntentBestEffort("transfer.remove", p),
    kind: "transfer.remove",
    target: "transfer_bridge",
    sample: (n) => ({ minimized: n % 2 === 1 }),
  },
  {
    name: "settingsBridge",
    setTransport: setSettingsTransportForTest,
    stop: stopSettingsSubscription,
    ensure: ensureSettingsSubscribed,
    onView: onSettingsView as BridgeCase["onView"],
    current: currentSettingsView,
    fire: (p) => mirrorSettingsIntent("settings.patch", p),
    kind: "settings.patch",
    target: "settings_bridge",
    sample: settingsDoc,
  },
];

let logs: LogEntry[] = [];
let offLog: (() => void) | null = null;

beforeEach(() => {
  logs = [];
  offLog = onFrontendLog((entry) => logs.push(entry));
});

afterEach(() => {
  offLog?.();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe.each(CASES)("$name failure paths", (c) => {
  let transport: ScriptedTransport;

  beforeEach(() => {
    transport = new ScriptedTransport(c.sample(1));
    c.setTransport(transport);
  });

  afterEach(() => {
    c.stop();
    c.setTransport(null);
  });

  const logsFor = (prefix: string) =>
    logs.filter((l) => l.target.endsWith(c.target) && l.message.startsWith(prefix));

  it("shares one subscription between concurrent ensure callers", async () => {
    const [a, b] = await Promise.all([c.ensure(), c.ensure()]);
    expect(a).toBe(b);
    expect(transport.subscribeCalls).toBe(1);
    // Once started, a later call resolves to the same client without subscribing.
    await expect(c.ensure()).resolves.toBe(a);
    expect(transport.subscribeCalls).toBe(1);
  });

  it("logs and rethrows a failed subscribe, then subscribes again on retry", async () => {
    transport.failSubscribes = 1;
    await expect(c.ensure()).rejects.toThrow("subscribe refused");
    expect(logsFor("subscribe")).toHaveLength(1);

    await c.ensure();
    expect(transport.subscribeCalls).toBe(2);
    expect(logsFor("subscribe")).toHaveLength(1);
  });

  it("isolates a throwing listener and still delivers to the others", async () => {
    const seen: unknown[] = [];
    const offBad = c.onView(() => {
      throw new Error("listener blew up");
    });
    const offGood = c.onView((v) => seen.push(v));
    await c.ensure();
    transport.push(c.sample(2), 2);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toEqual(c.current());
    expect(logsFor("reconcile").length).toBeGreaterThan(0);
    expect(logsFor("reconcile")[0].message).toContain("listener blew up");
    offBad();
    offGood();
  });

  it("logs a rejected ack, using the ack's message when present", async () => {
    transport.dispatchMode = {
      kind: "ack",
      ack: { status: "rejected", produced: [], error: { code: "x", message: "denied" } },
    } as DispatchMode;
    c.fire({});
    transport.dispatchMode = { kind: "ack", ack: { status: "rejected", produced: [] } };
    c.fire({});
    await flush();

    const messages = logsFor(c.kind).map((l) => l.message);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain("denied");
    expect(messages[1]).toContain("rejected");
  });

  it("does not log an accepted ack", async () => {
    c.fire({ id: "x" });
    await flush();
    expect(transport.dispatched.map((i) => i.kind)).toEqual([c.kind]);
    expect(logsFor(c.kind)).toEqual([]);
  });

  it("logs a dispatch whose promise rejects", async () => {
    transport.dispatchMode = { kind: "reject", error: new Error("pipe closed") };
    c.fire({});
    await flush();
    expect(logsFor(c.kind).map((l) => l.message)).toEqual([expect.stringContaining("pipe closed")]);
  });

  it("never throws when the transport cannot be built (non-Tauri, no socket)", () => {
    c.setTransport(null);
    expect(() => c.fire({})).not.toThrow();
    expect(logsFor(c.kind).map((l) => l.message)).toEqual([
      expect.stringContaining("JSON-RPC socket"),
    ]);
  });
});

/** Subscribe a bridge to a transport that serves `view`, returning the result. */
async function viewFrom(c: BridgeCase, view: unknown): Promise<unknown> {
  c.setTransport(new ScriptedTransport(view));
  await c.ensure();
  const got = c.current();
  c.stop();
  c.setTransport(null);
  return got;
}

const byName = (name: string) => CASES.find((c) => c.name === name)!;

describe("snapshot normalization", () => {
  it("agents: fills every absent field of a partial or empty snapshot", async () => {
    const c = byName("agentsBridge");
    expect(await viewFrom(c, { agents: [{ id: "a1" }] })).toEqual({
      ...EMPTY_AGENTS_VIEW,
      remoteAgents: [{ id: "a1" }],
    });
    expect(await viewFrom(c, { sessions: { a1: [] }, folders: { a1: [] } })).toEqual({
      ...EMPTY_AGENTS_VIEW,
      agentSessions: { a1: [] },
      agentFolders: { a1: [] },
    });
    expect(await viewFrom(c, { definitions: { a1: [] } })).toEqual({
      ...EMPTY_AGENTS_VIEW,
      agentDefinitions: { a1: [] },
    });
    expect(await viewFrom(c, undefined)).toEqual(EMPTY_AGENTS_VIEW);
  });

  it("broadcast: fills every absent field of a partial or empty snapshot", async () => {
    const c = byName("broadcastBridge");
    expect(await viewFrom(c, { active: true })).toEqual({
      ...EMPTY_BROADCAST_VIEW,
      active: true,
    });
    expect(await viewFrom(c, { sourceTabId: "t1", scope: "custom", targetTabIds: ["t1"] })).toEqual(
      {
        ...EMPTY_BROADCAST_VIEW,
        sourceTabId: "t1",
        scope: "custom",
        targetTabIds: ["t1"],
      }
    );
    expect(await viewFrom(c, { lastScope: "custom" })).toEqual({
      ...EMPTY_BROADCAST_VIEW,
      lastScope: "custom",
    });
    expect(await viewFrom(c, undefined)).toEqual(EMPTY_BROADCAST_VIEW);
  });

  it("monitors: defaults the maps and carries history only when present", async () => {
    const c = byName("systemMonitorBridge");
    expect(await viewFrom(c, undefined)).toEqual({ monitors: {}, statsCache: {} });
    const withHistory = (await viewFrom(c, { statsCache: {}, history: { m1: [] } })) as Record<
      string,
      unknown
    >;
    expect(withHistory).toEqual({ monitors: {}, statsCache: {}, history: { m1: [] } });
    const withoutHistory = (await viewFrom(c, { monitors: {} })) as Record<string, unknown>;
    expect("history" in withoutHistory).toBe(false);
  });

  it("transfers: defaults the queue and the minimized flag", async () => {
    const c = byName("transfersBridge");
    expect(await viewFrom(c, undefined)).toEqual({ queue: {}, minimized: false });
    expect(await viewFrom(c, { minimized: true })).toEqual({ queue: {}, minimized: true });
    expect(await viewFrom(c, { queue: {} })).toEqual({ queue: {}, minimized: false });
  });

  it("settings: ignores a snapshot that is not a full document", async () => {
    const c = byName("settingsBridge");
    expect(await viewFrom(c, undefined)).toEqual(DEFAULT_SETTINGS_VIEW);
    expect(await viewFrom(c, { theme: "dark" })).toEqual(DEFAULT_SETTINGS_VIEW);
    expect(await viewFrom(c, settingsDoc(7))).toEqual(settingsDoc(7));
  });
});

describe("seed mirrors", () => {
  afterEach(() => {
    stopAgentsSubscription();
    setAgentTransportForTest(null);
    stopSettingsSubscription();
    setSettingsTransportForTest(null);
  });

  const seedAgents = (tag: string) => seedAgentsRegion([{ id: tag } as never], {}, {}, {});
  const seedSettings = (tag: string) =>
    seedSettingsRegion({ ...DEFAULT_SETTINGS_VIEW, version: tag } as AppSettings);

  describe.each([
    {
      name: "agents",
      set: setAgentTransportForTest,
      seed: seedAgents,
      fallback: "agent.replace rejected",
    },
    {
      name: "settings",
      set: setSettingsTransportForTest,
      seed: seedSettings,
      fallback: "settings.replace rejected",
    },
  ])("$name seed", ({ set, seed, fallback }) => {
    it("rejects with a fallback message when the ack carries none, then retries", async () => {
      const transport = new ScriptedTransport();
      set(transport);
      transport.dispatchMode = { kind: "ack", ack: { status: "rejected", produced: [] } };
      await expect(seed("s1")).rejects.toThrow(fallback);

      // The failed seed did not latch its dedup signature: the same slice re-sends.
      transport.dispatchMode = { kind: "ack", ack: { status: "accepted", produced: [] } };
      await expect(seed("s1")).resolves.toBeUndefined();
      expect(transport.dispatched).toHaveLength(2);
    });

    it("wraps a synchronous non-Error throw into an Error, then retries", async () => {
      const transport = new ScriptedTransport();
      set(transport);
      transport.dispatchMode = { kind: "throw", error: "bare string failure" };
      const err = await seed("s2").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("bare string failure");

      transport.dispatchMode = { kind: "ack", ack: { status: "accepted", produced: [] } };
      await expect(seed("s2")).resolves.toBeUndefined();
    });

    it("keeps an Error thrown synchronously (no transport) as-is", async () => {
      set(null);
      await expect(seed("s3")).rejects.toThrow(/JSON-RPC socket/);
    });
  });
});
