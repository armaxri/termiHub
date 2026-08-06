/**
 * Agents projection bridge — the agent sidebar & Open Connections read the
 * **authoritative** `agents` projection region (#2226 hook-authoritative cut / PR A,
 * part of #2153 / #2139).
 *
 * The shared `agents` projection region, backed by the Rust
 * [`AgentsStore`](../../src-tauri/src/agents_projection/store.rs), is the source of
 * truth for the ordered remote-agent list, each agent's connection status, and its
 * live sessions, saved definitions and folders. The backend feeds it **at the
 * source**: agent status / CRUD streams fold every transition (#2388 / PR #2392) and
 * the server owns agent entry-creation + the startup list-load (#2403), so the region
 * is populated from boot and reflects every backend transition without a client
 * round-trip. The agent sidebar
 * ({@link import("../components/Sidebar/ConnectionList").ConnectionList} /
 * {@link import("../components/Sidebar/AgentNode").AgentNode}) and Open Connections
 * therefore read the region directly through
 * {@link import("./useProjectedAgents").useProjectedAgents}, with no `appStore` seed,
 * mirror gate, or fallback — the direct analog of the authoritative connections bridge
 * ({@link import("./connectionsBridge")}, #2225) and settings bridge
 * ({@link import("./settingsBridge")}, #2227).
 *
 * # Fully region-authoritative (#2409, PR B)
 *
 * The reducer removal is complete: `appStore` no longer holds an `agents` slice.
 * **Every** reader — the agent sidebar, Open Connections, the connection / tunnel
 * editors, the file browser, the status bar, and the store's own connect / session
 * / restore / tab logic — sources the ordered agent list and the per-agent
 * sessions / definitions / folders from this region, synchronously via
 * {@link currentAgentsView} or reactively via
 * {@link import("./useProjectedAgents").useProjectedAgents}. The agent lifecycle
 * actions are thin backend-command wrappers: each dispatches its granular
 * `agent.*` intent ({@link mirrorAgentIntent}) as the optimistic write, then calls
 * the agent RPC / persist command whose result the backend folds authoritatively
 * back into the region (the status / CRUD streams, #2388, and the persisted-list
 * fold, #2403). There is no local slice left to fall back to, so the mutation-cut
 * flag is gone. The per-client `agentUpdates` / `agentUpdatesDismissed` /
 * `agentUpdatePending` sub-slices are presentation state the region does not model
 * and stay in `appStore` (#2409).
 */

import {
  createTransport,
  newClientId,
  newIntentId,
  ProjectionClient,
  type IntentAck,
  type Transport,
} from "@/services/transport";
import type { AgentDefinitionInfo, AgentFolderInfo, AgentSessionInfo } from "@/services/api";
import type { RemoteAgentDefinition } from "@/types/connection";
import { frontendLog } from "@/utils/frontendLog";

/** The projection region id for the agents domain (twin of the Rust
 * `AGENTS_REGION` const). Shared (Open Design Decision #4). */
export const AGENTS_REGION = "agents";

/**
 * The projected agents view model, in `appStore` terms — a twin of the Rust store
 * snapshot with the frontend slice's field names: the ordered agent list plus the
 * per-agent live sessions, saved definitions and folders. The projected records
 * match the frontend {@link RemoteAgentDefinition} / {@link AgentSessionInfo} /
 * {@link AgentDefinitionInfo} / {@link AgentFolderInfo} shapes one-to-one, so the
 * read is a pure parity swap.
 */
export interface AgentsView {
  remoteAgents: RemoteAgentDefinition[];
  agentSessions: Record<string, AgentSessionInfo[]>;
  agentDefinitions: Record<string, AgentDefinitionInfo[]>;
  agentFolders: Record<string, AgentFolderInfo[]>;
}

/** The empty view a fresh region reports (twin of the empty store snapshot). */
export const EMPTY_AGENTS_VIEW: AgentsView = {
  remoteAgents: [],
  agentSessions: {},
  agentDefinitions: {},
  agentFolders: {},
};

/**
 * The raw region view model as the Rust store serialises it, keyed
 * `agents/sessions/definitions/folders` (see `AgentsStore::snapshot`). Mapped to
 * the `appStore`-named {@link AgentsView} on the way in ({@link toView}) and back
 * on the way out ({@link seedAgentsRegion}).
 */
interface AgentsRegionSnapshot {
  agents?: RemoteAgentDefinition[];
  sessions?: Record<string, AgentSessionInfo[]>;
  definitions?: Record<string, AgentDefinitionInfo[]>;
  folders?: Record<string, AgentFolderInfo[]>;
}

/** Translate the raw region snapshot into the `appStore`-named view. */
function toView(raw: AgentsRegionSnapshot): AgentsView {
  return {
    remoteAgents: raw.agents ?? [],
    agentSessions: raw.sessions ?? {},
    agentDefinitions: raw.definitions ?? {},
    agentFolders: raw.folders ?? {},
  };
}

// ── Transport + shared region client (lazy, mirrors the connections slice) ─────

let transportInstance: Transport | null = null;
let regionClient: ProjectionClient | null = null;
let startPromise: Promise<ProjectionClient> | null = null;

// A stable per-session client identity for dispatched intents (fan-out / audit
// only; the shared region's diff reaches every subscriber regardless of who
// dispatched it).
const clientId = newClientId();

/** Inject a transport for tests; `null` restores the lazily-created real one and
 * drops any active subscription / view + seed dedup state. */
export function setAgentTransportForTest(t: Transport | null): void {
  regionClient?.stop();
  regionClient = null;
  startPromise = null;
  transportInstance = t;
  resetViewState();
  lastSeededSignature = null;
}

function transport(): Transport {
  if (!transportInstance) {
    transportInstance = createTransport();
  }
  return transportInstance;
}

// ── View fan-out (one subscription, many consuming hooks) ──────────────────────

/** A change listener for the projected `agents` view. */
export type AgentsViewListener = (view: AgentsView) => void;

const viewListeners = new Set<AgentsViewListener>();
// The last projected view received, defaulting to the empty baseline so a
// synchronous read before the first diff still returns a valid view.
let lastView: AgentsView = EMPTY_AGENTS_VIEW;
// A content signature of `lastView`, so an identical-content diff (e.g. a resync
// re-delivering the same view with a fresh object identity) does not churn the
// view identity or re-notify subscribers — which would trigger needless re-renders.
let lastViewSignature: string = JSON.stringify(EMPTY_AGENTS_VIEW);
// The monotonic region version of `lastView`. A projected view older than this is
// stale (e.g. an initial subscribe snapshot delivered late, after a newer diff has
// already landed) and is ignored, so it can never clobber the current view.
let lastAppliedVersion = -1;

/** Reset the fan-out state to the empty baseline (tests / re-init). */
function resetViewState(): void {
  lastView = EMPTY_AGENTS_VIEW;
  lastViewSignature = JSON.stringify(EMPTY_AGENTS_VIEW);
  lastAppliedVersion = -1;
}

/**
 * Commit a projected view (at its region `version`) as the current view and notify
 * subscribers — but only when it is not stale and its content actually changed.
 * Ignoring an older version stops a late-delivered snapshot from overwriting a
 * newer view (the agents region is live — status streams push diffs continuously,
 * so a late subscribe snapshot racing a fresh diff is a real case); preserving
 * identity for unchanged content keeps the reader hooks' value referentially stable
 * across resyncs.
 */
function commitAgentsView(view: AgentsView, version: number): void {
  if (version < lastAppliedVersion) return;
  lastAppliedVersion = version;
  const signature = JSON.stringify(view);
  if (signature === lastViewSignature) return;
  lastView = view;
  lastViewSignature = signature;
  for (const listener of viewListeners) {
    try {
      listener(view);
    } catch (err) {
      logAgentBridgeFallback("reconcile", err);
    }
  }
}

/**
 * Register a listener, invoked with the projected view on every diff. Returns an
 * unsubscribe. The region client is started on first use.
 */
export function onAgentsView(listener: AgentsViewListener): () => void {
  viewListeners.add(listener);
  return () => viewListeners.delete(listener);
}

/**
 * Ensure the shared `agents` region client is subscribed so projected diffs are
 * received and fanned out to the {@link onAgentsView} listeners. Idempotent and
 * de-duplicated across concurrent callers; a transport/subscribe failure is logged
 * and rethrown so the caller can react.
 */
export function ensureAgentsSubscribed(): Promise<ProjectionClient> {
  if (regionClient) return Promise.resolve(regionClient);
  if (!startPromise) {
    const client = new ProjectionClient(transport(), AGENTS_REGION);
    client.onChange((state) => {
      // `state.version` is the region's monotonic version (used for the stale-diff
      // guard), independent of any field inside the projected view.
      commitAgentsView(toView((state.view ?? {}) as AgentsRegionSnapshot), state.version);
    });
    startPromise = client
      .start()
      .then(() => {
        regionClient = client;
        return client;
      })
      .catch((err) => {
        startPromise = null;
        logAgentBridgeFallback("subscribe", err);
        throw err;
      });
  }
  return startPromise;
}

/** Drop the region subscription (tests / re-init). */
export function stopAgentsSubscription(): void {
  regionClient?.stop();
  regionClient = null;
  startPromise = null;
  resetViewState();
  lastSeededSignature = null;
}

/**
 * The last projected view received (for a hook that subscribes after the first
 * diff, and for synchronous reads). Since the region is authoritative and the
 * backend feeds every transition at the source (#2388 / #2403), this is the
 * frontend's current picture of the agents domain; before the first diff it is the
 * {@link EMPTY_AGENTS_VIEW} baseline.
 */
export function currentAgentsView(): AgentsView {
  return lastView;
}

/**
 * Test-only: synchronously set the projected view (at a region `version`) and notify
 * subscribers, without the async transport subscribe round-trip. The agents region
 * test harness uses this to mirror an `appStore`-driven test's slice into the region
 * immediately, so a reader that renders (or re-renders on a mutation) sees the slice
 * without an explicit flush — matching the synchronous behaviour the removed
 * `appStore` fallback used to provide. Never call this from production code.
 */
export function __emitAgentsViewForTest(view: AgentsView, version: number): void {
  commitAgentsView(view, version);
}

/**
 * Test seam: synchronously set the cached region view and fan it to listeners,
 * standing in for the server-side stream/fold so a unit/component test can drive
 * the authoritative region without a live backend. Bypasses the stale-version /
 * signature guards {@link commitAgentsView} applies to real diffs (a seed is
 * always the intended current view), advancing `lastAppliedVersion` so a later
 * real diff is not treated as stale relative to the seed. The twin of the
 * connections bridge's `setConnectionsViewForTest`. Never call from production.
 */
export function setAgentsViewForTest(view: AgentsView): void {
  lastView = view;
  lastViewSignature = JSON.stringify(view);
  lastAppliedVersion += 1;
  for (const listener of viewListeners) {
    try {
      listener(view);
    } catch (err) {
      logAgentBridgeFallback("reconcile", err);
    }
  }
}

// ── Seed: reliably push appStore's slice into the region (agent.replace) ───────

let lastSeededSignature: string | null = null;

/**
 * Push `appStore`'s whole agents slice into the shared region via an `agent.replace`
 * intent. The backend now feeds the region at the source (#2388 / #2403), so this is
 * no longer part of the render path — it remains as a **reliable** appStore→region
 * mirror for the test harness (and any diagnostic re-seed): the returned promise
 * resolves only once the region has accepted the replace and rejects on a rejected
 * ack or a transport failure, so a caller can await the mirror rather than
 * fire-and-forget. The payload is keyed to the Rust snapshot shape
 * (`agents/sessions/definitions/folders`). De-duplicated: a slice identical to the
 * last seeded one is not re-dispatched (a repeated no-op is idempotent server-side
 * anyway). On any failure the dedup signature is cleared so a later change retries
 * the mirror.
 */
export function seedAgentsRegion(
  remoteAgents: RemoteAgentDefinition[],
  agentSessions: Record<string, AgentSessionInfo[]>,
  agentDefinitions: Record<string, AgentDefinitionInfo[]>,
  agentFolders: Record<string, AgentFolderInfo[]>
): Promise<void> {
  const payload = {
    agents: remoteAgents,
    sessions: agentSessions,
    definitions: agentDefinitions,
    folders: agentFolders,
  };
  const signature = JSON.stringify(payload);
  if (signature === lastSeededSignature) return Promise.resolve();
  // Set before dispatching so concurrent callers do not double-dispatch the seed.
  lastSeededSignature = signature;
  try {
    return transport()
      .dispatch({
        intentId: newIntentId(),
        kind: "agent.replace",
        payload,
        clientId,
      })
      .then((ack: IntentAck) => {
        if (ack.status === "rejected") {
          // Let a later change retry the seed rather than latch on a failure.
          lastSeededSignature = null;
          throw new Error(ack.error?.message ?? "agent.replace rejected");
        }
      })
      .catch((err) => {
        lastSeededSignature = null;
        throw err;
      });
  } catch (err) {
    // A synchronous transport-construction failure (non-Tauri, no socket).
    lastSeededSignature = null;
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

// ── Mutation cut: granular agent.* intent dispatch ────────────────────────────

/**
 * The granular `agent.*` intent kinds the lifecycle actions dispatch (twins of the
 * Rust routes). Excludes `agent.replace`, which is the whole-slice mirror
 * ({@link seedAgentsRegion}); the actions drive the region through these
 * per-transition intents as their optimistic write.
 */
export type AgentIntentKind =
  | "agent.add"
  | "agent.update"
  | "agent.applySettings"
  | "agent.remove"
  | "agent.reorder"
  | "agent.toggleExpanded"
  | "agent.status"
  | "agent.setCapabilities"
  | "agent.disconnect"
  | "agent.refresh"
  | "agent.clearSessions"
  | "agent.saveDefinition"
  | "agent.updateDefinition"
  | "agent.deleteDefinition"
  | "agent.createFolder"
  | "agent.updateFolder"
  | "agent.deleteFolder";

/** Dispatch a granular `agent.*` intent, resolving with the ack (parity tests). */
export function dispatchAgentIntent(
  kind: AgentIntentKind,
  payload: Record<string, unknown>
): Promise<IntentAck> {
  return transport().dispatch({ intentId: newIntentId(), kind, payload, clientId });
}

/**
 * Fire a granular `agent.*` intent against the authoritative region — the agent
 * lifecycle actions' optimistic write. Since the reducer removal (#2226 PR B) the
 * `appStore` agents slice is gone, so this is no longer a "mirror" of a local
 * mutation: it **is** the mutation's client-side transition, applied to the shared
 * `agents` region ahead of the backend's authoritative fold (the agent status /
 * CRUD streams, #2388, and the persisted-list fold, #2403) so the UI updates
 * instantly. Best-effort: any dispatch failure is swallowed and logged (the
 * backend still feeds the region at the source), and a synchronous
 * transport-construction failure (non-Tauri, no socket) is caught too, so it never
 * throws out of a reducer. The twin of the connections bridge's
 * {@link import("./connectionsBridge").mirrorConnectionIntent}.
 */
export function mirrorAgentIntent(kind: AgentIntentKind, payload: Record<string, unknown>): void {
  try {
    void dispatchAgentIntent(kind, payload)
      .then((ack) => {
        if (ack.status === "rejected") {
          logAgentBridgeFallback(kind, new Error(ack.error?.message ?? "rejected"));
        }
      })
      .catch((err) => logAgentBridgeFallback(kind, err));
  } catch (err) {
    logAgentBridgeFallback(kind, err);
  }
}

/** Log a bridge dispatch failure so it is visible in the LogViewer. */
export function logAgentBridgeFallback(kind: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  frontendLog("agent_bridge", `${kind} agent intent failed: ${message}`);
}
