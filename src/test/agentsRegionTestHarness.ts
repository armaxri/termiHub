/**
 * Test harness for the authoritative `agents` projection region (#2226 PR A).
 *
 * The agent sidebar ({@link import("@/components/Sidebar/ConnectionList").ConnectionList} /
 * {@link import("@/components/Sidebar/AgentNode").AgentNode}) and Open Connections
 * read the ordered agent list, connection status and per-agent
 * sessions/definitions/folders from the shared `agents` region
 * ({@link import("@/store/useProjectedAgents").useProjectedAgents}), which is now the
 * source of truth — tests can no longer seed agents into `appStore` and expect the UI
 * to reflect them; they seed the **region**.
 *
 * {@link FakeAgentsTransport} is an in-memory twin of the Rust `AgentsStore`: it holds
 * one region view keyed to the Rust snapshot shape (`agents/sessions/definitions/
 * folders`), folds the whole-slice `agent.replace` intent **exactly as the backend
 * routes it**, and fans a fresh snapshot to every subscriber. `agent.replace` is the
 * intent the appStore→region mirror uses, so folding it faithfully is all the
 * render-reader tests need; the granular `agent.*` intents (the mutation cut) are
 * accepted and recorded but drive nothing here — they are validated in the bridge /
 * mutation-cut unit tests, not in a component render test.
 *
 * Most render-reader tests want {@link setupAgentsRegionMirror}: call it once at the
 * top of a test module (or inside a `describe`) and it keeps the region mirrored from
 * `appStore`'s agents slice for the duration of each test, so the existing
 * `appStore`-driven setup (`useAppStore.setState({ remoteAgents })`) keeps rendering
 * correctly through the region-authoritative hook.
 */

import { afterEach, beforeEach } from "vitest";

import type {
  FrameHandler,
  Intent,
  IntentAck,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";
import { useAppStore } from "@/store/appStore";
import {
  __emitAgentsViewForTest,
  AGENTS_REGION,
  EMPTY_AGENTS_VIEW,
  setAgentTransportForTest,
  stopAgentsSubscription,
  type AgentsView,
} from "@/store/agentsBridge";

/** The current `appStore` agents slice as an {@link AgentsView}. */
function appStoreView(): AgentsView {
  const { remoteAgents, agentSessions, agentDefinitions, agentFolders } = useAppStore.getState();
  return { remoteAgents, agentSessions, agentDefinitions, agentFolders };
}

/** The region-snapshot shape the Rust `AgentsStore` serialises. */
interface AgentsRegionSnapshot {
  agents: AgentsView["remoteAgents"];
  sessions: AgentsView["agentSessions"];
  definitions: AgentsView["agentDefinitions"];
  folders: AgentsView["agentFolders"];
}

/** Map an {@link AgentsView} into the Rust snapshot shape. */
function toSnapshot(view: AgentsView): AgentsRegionSnapshot {
  return {
    agents: view.remoteAgents,
    sessions: view.agentSessions,
    definitions: view.agentDefinitions,
    folders: view.agentFolders,
  };
}

/**
 * An in-memory substrate double for the `agents` region: holds one view (in the Rust
 * snapshot shape), folds the whole-slice `agent.replace` intent like the Rust
 * `AgentsStore`, and fans a snapshot to every subscriber. Faithful to the backend's
 * `agent.replace` payload envelope (`{ agents, sessions, definitions, folders }`) so a
 * client-dispatched mirror round-trips back into the projected view exactly as it
 * would in production.
 */
export class FakeAgentsTransport implements Transport {
  dispatched: Intent[] = [];
  private view: AgentsRegionSnapshot = toSnapshot(EMPTY_AGENTS_VIEW);
  private version = 0;
  private handlers = new Set<FrameHandler>();

  /** Seed the region view directly (test setup), fanning a snapshot. */
  seed(view: AgentsView): void {
    this.view = structuredClone(toSnapshot(view));
    this.bump();
  }

  /** Intent kinds dispatched, in order (assertion helper). */
  kinds(): string[] {
    return this.dispatched.map((i) => i.kind);
  }

  /** The current projected view (assertion helper). */
  regionView(): AgentsView {
    const v = structuredClone(this.view);
    return {
      remoteAgents: v.agents,
      agentSessions: v.sessions,
      agentDefinitions: v.definitions,
      agentFolders: v.folders,
    };
  }

  /** The current monotonic region version (mirrors the Rust store's version). */
  currentVersion(): number {
    return this.version;
  }

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    if (intent.kind === "agent.replace") {
      const p = intent.payload as Record<string, unknown>;
      this.view = {
        agents: (p.agents ?? []) as AgentsRegionSnapshot["agents"],
        sessions: (p.sessions ?? {}) as AgentsRegionSnapshot["sessions"],
        definitions: (p.definitions ?? {}) as AgentsRegionSnapshot["definitions"],
        folders: (p.folders ?? {}) as AgentsRegionSnapshot["folders"],
      };
      this.bump();
      return {
        intentId: intent.intentId,
        status: "accepted",
        produced: [{ region: AGENTS_REGION, version: this.version }],
      };
    }
    // Granular agent.* intents are recorded but do not fold here.
    return { intentId: intent.intentId, status: "accepted", produced: [] };
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
    const frame = this.snapshot(AGENTS_REGION);
    for (const h of this.handlers) h(frame);
  }
}

/**
 * Install a {@link FakeAgentsTransport} as the agents bridge's transport and
 * optionally seed it with the initial view. Returns the transport plus a `teardown`
 * that drops the subscription and restores the real transport — call it in
 * `afterEach`.
 */
export function installAgentsHarness(initial?: AgentsView): {
  transport: FakeAgentsTransport;
  teardown: () => void;
} {
  const transport = new FakeAgentsTransport();
  setAgentTransportForTest(transport);
  if (initial) transport.seed(initial);
  return {
    transport,
    teardown: () => {
      stopAgentsSubscription();
      setAgentTransportForTest(null);
    },
  };
}

/**
 * Install a {@link FakeAgentsTransport} that **mirrors `appStore`'s agents slice into
 * the region**, for the many render-reader tests that drive agents through `appStore`
 * (`useAppStore.setState({ remoteAgents })`, or an action that mutates the slice) and
 * assert on the agent sidebar / Open Connections.
 *
 * Now that {@link import("@/store/useProjectedAgents").useProjectedAgents} reads the
 * region authoritatively, those tests can no longer rely on the removed `appStore`
 * fallback — the UI renders what the region projects. This helper seeds the region
 * with the current slice and re-seeds it on every agents-slice change, so the region
 * tracks whatever the test puts in `appStore` — the test-side analog of production,
 * where the region is fed from the backend at the source (#2388 / #2403). Returns the
 * transport plus a `teardown` (drops the appStore subscription, the region
 * subscription, and restores the real transport) — call it in `afterEach`.
 */
export function installAgentsHarnessMirroringAppStore(): {
  transport: FakeAgentsTransport;
  teardown: () => void;
} {
  const { transport, teardown } = installAgentsHarness();
  // Seed the transport (so the hook's eventual subscribe snapshot is correct) AND
  // synchronously emit the view (so a reader mounting/re-rendering now reflects it
  // without waiting for the subscribe round-trip).
  const push = (view: AgentsView): void => {
    transport.seed(view);
    __emitAgentsViewForTest(view, transport.currentVersion());
  };
  push(appStoreView());
  const unsubscribe = useAppStore.subscribe((state, prev) => {
    if (
      state.remoteAgents !== prev.remoteAgents ||
      state.agentSessions !== prev.agentSessions ||
      state.agentDefinitions !== prev.agentDefinitions ||
      state.agentFolders !== prev.agentFolders
    ) {
      push(appStoreView());
    }
  });
  return {
    transport,
    teardown: () => {
      unsubscribe();
      teardown();
    },
  };
}

/**
 * Register the appStore→region mirror ({@link installAgentsHarnessMirroringAppStore})
 * for a whole test file via self-managed `beforeEach`/`afterEach` hooks. Call once at
 * the top of a render-reader test's module (or describe) so its existing
 * `appStore`-driven agents setup keeps rendering correctly now that
 * {@link import("@/store/useProjectedAgents").useProjectedAgents} reads the region
 * authoritatively — no per-`beforeEach` wiring needed. The mirror's live subscription
 * re-seeds the region on every agents-slice change during the test, so a later
 * `setState` or an agents-mutating action still reaches the UI.
 */
export function setupAgentsRegionMirror(): void {
  let harness: { transport: FakeAgentsTransport; teardown: () => void } | undefined;
  beforeEach(() => {
    harness = installAgentsHarnessMirroringAppStore();
  });
  afterEach(() => {
    harness?.teardown();
    harness = undefined;
  });
}
