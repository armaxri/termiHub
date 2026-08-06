/**
 * Test harness for the region-authoritative `agents` domain (#2226).
 *
 * The agent sidebar ({@link import("@/components/Sidebar/ConnectionList").ConnectionList} /
 * {@link import("@/components/Sidebar/AgentNode").AgentNode}), Open Connections, the
 * connection / tunnel editors, the file browser, the status bar and the store's own
 * connect / restore / reconnect logic all read the ordered agent list, connection
 * status and per-agent sessions/definitions/folders from the shared `agents` region
 * ({@link import("@/store/useProjectedAgents").useProjectedAgents} /
 * {@link import("@/store/agentsBridge").currentAgentsView}), which since the reducer
 * removal (#2409, PR B) is the sole source of truth — `appStore` holds no agents
 * slice. Tests can no longer seed agents into `appStore` and expect the UI to reflect
 * them; they seed the **region**.
 *
 * Two harness flavours live here:
 *
 * - {@link FakeAgentsTransport} + {@link installAgentsHarness}: an in-memory twin of
 *   the Rust `AgentsStore` that folds the whole-slice `agent.replace` intent exactly
 *   as the backend routes it (the bridge / hook unit tests use it to exercise the
 *   subscribe / diff / seed plumbing directly).
 *
 * - {@link setupAgentsRegion} + {@link seedAgentsRegion}: the region-direct harness
 *   most component tests want — it seeds the region synchronously and folds the
 *   granular `agent.*` intents the lifecycle actions dispatch (a faithful stand-in
 *   for the server-side stream/fold), so a UI-driven mutation (connect, rename a
 *   folder, delete a definition) updates the rendered tree. This supersedes the
 *   render-cut-era appStore→region mirror harness, which mirrored `appStore`'s
 *   agents slice — a slice that no longer exists.
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
import type { AgentDefinitionInfo, AgentFolderInfo, AgentSessionInfo } from "@/services/api";
import type { RemoteAgentDefinition } from "@/types/connection";
import {
  AGENTS_REGION,
  EMPTY_AGENTS_VIEW,
  setAgentsViewForTest,
  setAgentTransportForTest,
  stopAgentsSubscription,
  type AgentsView,
} from "@/store/agentsBridge";

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

// ── Region-direct harness (folds the granular agent.* intents) ────────────────

/** The empty region view a fresh test starts from. */
const EMPTY: AgentsView = EMPTY_AGENTS_VIEW;

/** The currently-seeded region view, mirrored by {@link SeededAgentsTransport}. */
let current: AgentsView = EMPTY;

/** A fresh, disconnected, collapsed agent entry (mirrors the Rust `AgentEntry::new`). */
function newEntry(payload: Record<string, unknown>): RemoteAgentDefinition {
  return {
    id: payload.id as string,
    name: payload.name as string,
    config: (payload.config ?? {}) as RemoteAgentDefinition["config"],
    agentSettings: (payload.agentSettings ?? {}) as RemoteAgentDefinition["agentSettings"],
    isExpanded: false,
    connectionState: "disconnected",
  };
}

/**
 * Apply an `agent.*` intent to the seeded view, mirroring the Rust
 * [`AgentsStore`](../../src-tauri/src/agents_projection/store.rs) routes one-to-one —
 * the faithful stand-in for the server-side stream/fold. This is what lets a component
 * test drive a real UI mutation (connect an agent, rename a folder, delete a
 * definition) and see the region — and therefore the rendered tree — update, exactly
 * as the backend fold would in production.
 */
function applyAgentIntent(
  view: AgentsView,
  kind: string,
  payload: Record<string, unknown>
): AgentsView {
  const remoteAgents = [...view.remoteAgents];
  const agentSessions = { ...view.agentSessions };
  const agentDefinitions = { ...view.agentDefinitions };
  const agentFolders = { ...view.agentFolders };
  const id = payload.id as string;
  const mapAgent = (fn: (a: RemoteAgentDefinition) => RemoteAgentDefinition): void => {
    const idx = remoteAgents.findIndex((a) => a.id === id);
    if (idx >= 0) remoteAgents[idx] = fn(remoteAgents[idx]);
  };
  const known = (): boolean => remoteAgents.some((a) => a.id === id);
  switch (kind) {
    case "agent.add":
      if (!known()) remoteAgents.push(newEntry(payload));
      break;
    case "agent.update":
      mapAgent((a) => ({
        ...a,
        name: payload.name as string,
        config: (payload.config ?? a.config) as RemoteAgentDefinition["config"],
        agentSettings: (payload.agentSettings ??
          a.agentSettings) as RemoteAgentDefinition["agentSettings"],
      }));
      break;
    case "agent.applySettings":
      mapAgent((a) => ({
        ...a,
        agentSettings: payload.agentSettings as RemoteAgentDefinition["agentSettings"],
      }));
      break;
    case "agent.remove": {
      const idx = remoteAgents.findIndex((a) => a.id === id);
      if (idx >= 0) remoteAgents.splice(idx, 1);
      delete agentSessions[id];
      delete agentDefinitions[id];
      delete agentFolders[id];
      break;
    }
    case "agent.reorder": {
      const oldIndex = payload.oldIndex as number;
      const newIndex = payload.newIndex as number;
      if (
        oldIndex >= 0 &&
        oldIndex < remoteAgents.length &&
        newIndex >= 0 &&
        newIndex < remoteAgents.length
      ) {
        const [moved] = remoteAgents.splice(oldIndex, 1);
        remoteAgents.splice(newIndex, 0, moved);
      }
      break;
    }
    case "agent.toggleExpanded":
      mapAgent((a) => ({ ...a, isExpanded: !a.isExpanded }));
      break;
    case "agent.status": {
      const state = payload.state as RemoteAgentDefinition["connectionState"];
      const error = payload.error as string | undefined;
      mapAgent((a) => {
        let lastError = a.lastError;
        if (state === "disconnected") lastError = error ?? a.lastError;
        else if (state === "connecting" || state === "connected") lastError = undefined;
        return { ...a, connectionState: state, lastError };
      });
      break;
    }
    case "agent.setCapabilities":
      mapAgent((a) => ({
        ...a,
        capabilities: payload.capabilities as RemoteAgentDefinition["capabilities"],
      }));
      break;
    case "agent.disconnect":
      if (known()) {
        mapAgent((a) => ({ ...a, connectionState: "disconnected" }));
        agentSessions[id] = [];
        agentFolders[id] = [];
      }
      break;
    case "agent.refresh":
      if (known()) {
        agentSessions[id] = (payload.sessions ?? []) as AgentSessionInfo[];
        agentDefinitions[id] = (payload.definitions ?? []) as AgentDefinitionInfo[];
        agentFolders[id] = (payload.folders ?? []) as AgentFolderInfo[];
      }
      break;
    case "agent.clearSessions":
      if (known()) agentSessions[id] = [];
      break;
    case "agent.saveDefinition":
      if (known()) {
        const def = payload.definition as AgentDefinitionInfo;
        agentDefinitions[id] = [
          ...(agentDefinitions[id] ?? []).filter((d) => d.id !== def.id),
          def,
        ];
      }
      break;
    case "agent.updateDefinition": {
      const def = payload.definition as AgentDefinitionInfo;
      if (agentDefinitions[id]) {
        agentDefinitions[id] = agentDefinitions[id].map((d) => (d.id === def.id ? def : d));
      }
      break;
    }
    case "agent.deleteDefinition": {
      const definitionId = payload.definitionId as string;
      if (agentDefinitions[id]) {
        agentDefinitions[id] = agentDefinitions[id].filter((d) => d.id !== definitionId);
      }
      break;
    }
    case "agent.createFolder":
      if (known()) {
        const folder = payload.folder as AgentFolderInfo;
        agentFolders[id] = [...(agentFolders[id] ?? []).filter((f) => f.id !== folder.id), folder];
      }
      break;
    case "agent.updateFolder": {
      const folder = payload.folder as AgentFolderInfo;
      if (agentFolders[id]) {
        agentFolders[id] = agentFolders[id].map((f) => (f.id === folder.id ? folder : f));
      }
      break;
    }
    case "agent.deleteFolder": {
      const folderId = payload.folderId as string;
      if (agentFolders[id]) {
        agentFolders[id] = agentFolders[id].filter((f) => f.id !== folderId);
      }
      if (agentDefinitions[id]) {
        agentDefinitions[id] = agentDefinitions[id].map((d) =>
          d.folderId === folderId ? { ...d, folderId: null } : d
        );
      }
      break;
    }
    case "agent.replace":
      return {
        remoteAgents: (payload.agents ?? []) as RemoteAgentDefinition[],
        agentSessions: (payload.sessions ?? {}) as AgentsView["agentSessions"],
        agentDefinitions: (payload.definitions ?? {}) as AgentsView["agentDefinitions"],
        agentFolders: (payload.folders ?? {}) as AgentsView["agentFolders"],
      };
    default:
      break;
  }
  return { remoteAgents, agentSessions, agentDefinitions, agentFolders };
}

/**
 * A transport double whose region subscription snapshot always reflects the
 * currently-seeded view — so the reader hooks' mount-time subscribe agrees with the
 * synchronously-primed region cache. Dispatched `agent.*` intents are recorded (for
 * {@link agentsHarnessDispatched}) **and** folded into the seeded view via
 * {@link applyAgentIntent}, standing in for the production server-side fold so a
 * UI-driven mutation updates the rendered tree.
 */
class SeededAgentsTransport implements Transport {
  dispatched: Intent[] = [];
  private version = 1;

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    if (typeof intent.kind === "string" && intent.kind.startsWith("agent.")) {
      current = applyAgentIntent(
        current,
        intent.kind,
        (intent.payload ?? {}) as Record<string, unknown>
      );
      setAgentsViewForTest(current);
    }
    return { intentId: intent.intentId, status: "accepted", produced: [] };
  }

  async subscribe(region: string, _onFrame: FrameHandler): Promise<Subscription> {
    this.version += 1;
    return {
      snapshot: {
        kind: "snapshot",
        region,
        version: this.version,
        view: toSnapshot(structuredClone(current)),
      },
      unsubscribe: () => {},
    };
  }

  async resync(): Promise<SnapshotFrame | null> {
    return null;
  }
}

let activeSeededTransport: SeededAgentsTransport | null = null;

/**
 * Seed (or extend) the authoritative `agents` region for the current test. Merges
 * with the currently-seeded view — passing only `remoteAgents` leaves the seeded
 * sessions/definitions/folders untouched and vice-versa — mirroring how the retired
 * `useAppStore.setState({ remoteAgents })` shallow-merged the slice. Fans the new
 * view to any subscribed reader hooks so they re-render.
 */
export function seedAgentsRegion(partial: Partial<AgentsView>): void {
  current = {
    remoteAgents: partial.remoteAgents ?? current.remoteAgents,
    agentSessions: partial.agentSessions ?? current.agentSessions,
    agentDefinitions: partial.agentDefinitions ?? current.agentDefinitions,
    agentFolders: partial.agentFolders ?? current.agentFolders,
  };
  setAgentsViewForTest(current);
}

/** Reset the seeded region back to empty (called by the `beforeEach` install). */
export function resetAgentsRegion(): void {
  current = EMPTY;
  setAgentsViewForTest(current);
}

/** The intents the region-direct transport double has recorded this test. */
export function agentsHarnessDispatched(): Intent[] {
  return activeSeededTransport?.dispatched ?? [];
}

/**
 * Install the region-direct transport double and reset the seed to empty. Returns a
 * teardown. Prefer {@link setupAgentsRegion}, which wires the lifecycle.
 */
export function installAgentsRegion(): () => void {
  activeSeededTransport = new SeededAgentsTransport();
  setAgentTransportForTest(activeSeededTransport);
  resetAgentsRegion();
  return () => {
    stopAgentsSubscription();
    setAgentTransportForTest(null);
    activeSeededTransport = null;
    current = EMPTY;
  };
}

/**
 * Register a `beforeEach` / `afterEach` pair that installs the region-direct transport
 * double (seeded empty) for every test in the current module. Call once at module
 * scope, then use {@link seedAgentsRegion} inside individual tests. The replacement
 * for the retired `setupAgentsRegion`.
 */
export function setupAgentsRegion(): void {
  let teardown: (() => void) | undefined;
  beforeEach(() => {
    teardown = installAgentsRegion();
  });
  afterEach(() => {
    teardown?.();
    teardown = undefined;
  });
}
