/**
 * Agents projection bridge — Phase 5 render cut of the Agents domain (#2226,
 * part of #2139).
 *
 * The Agents **shadow** (PR #2232) landed a backend-authoritative
 * [`AgentsStore`](../../src-tauri/src/agents_projection/store.rs) served as the
 * shared `agents` projection region, with `agent.*` intents, but nothing in the
 * UI touched it. This step makes the **agent sidebar** and **Open Connections**
 * source the agent list, connection status and per-agent
 * sessions/definitions/folders from that region — the parity-safe render cut (the
 * direct analog of the system-monitor render cut
 * {@link import("./systemMonitorBridge")}, #2224, and the session render cut
 * {@link import("./useSessionLifecycle")}, #2204).
 *
 * # Strangler safety — flag-gated, on by default, faithful-mirror gate
 *
 * The `appStore` agents slice is still authoritative (the mutation cut is a later
 * step). To keep the render cut parity-safe **independent of any mutation flag**,
 * the region is kept a faithful copy of `appStore` by {@link seedAgentsRegion} (an
 * `agent.replace` mirror, the analog of the monitor bridge's `monitor.replace`
 * seed), and the UI renders from the region **only when it faithfully mirrors**
 * `appStore` ({@link agentsViewMirrors}); otherwise it falls back to `appStore`
 * verbatim. Because the gate guarantees the projected view deep-equals `appStore`'s
 * slice, the rendered output is byte-identical to the pre-cut path.
 *
 * Gated by {@link agentRenderFromProjectionEnabled} — **on by default**.
 * Overridable at runtime for rollback / tests via
 * `window.__TERMIHUB_AGENT_RENDER_FROM_PROJECTION__` or
 * `localStorage["termihub.agentRenderFromProjection"]` (set `"false"` to render
 * straight from `appStore`).
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
 * render cut is a pure parity swap.
 */
export interface AgentsView {
  remoteAgents: RemoteAgentDefinition[];
  agentSessions: Record<string, AgentSessionInfo[]>;
  agentDefinitions: Record<string, AgentDefinitionInfo[]>;
  agentFolders: Record<string, AgentFolderInfo[]>;
}

/** The empty view a fresh region reports (twin of the empty store snapshot). */
const EMPTY_VIEW: AgentsView = {
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

// ── Render-cut feature flag (runtime-flippable, on by default) ─────────────────

let renderFlagOverride: boolean | null = null;

interface AgentRenderFlagWindow {
  __TERMIHUB_AGENT_RENDER_FROM_PROJECTION__?: boolean;
  localStorage?: Storage;
}

/**
 * Programmatic override for the render-cut flag (tests, and a runtime toggle).
 * `null` clears the override and falls back to the window/localStorage signal,
 * then to the default (on).
 */
export function setAgentRenderFromProjectionEnabled(value: boolean | null): void {
  renderFlagOverride = value;
}

/**
 * Whether the agent sidebar and Open Connections render the agent list,
 * connection status and per-agent sessions/definitions/folders from the projected
 * `agents` region instead of reading `appStore`'s agents slice directly.
 *
 * **On by default** — the render cut is parity-safe: the UI renders from the
 * region only when it faithfully mirrors `appStore` ({@link agentsViewMirrors}),
 * and otherwise falls back to `appStore` verbatim, so the output is byte-identical
 * to the pre-cut path. Independent of the (later) mutation cut: the region is kept
 * a mirror of `appStore` by {@link seedAgentsRegion}, so it is always populated.
 * Overridable at runtime for rollback / tests via
 * `window.__TERMIHUB_AGENT_RENDER_FROM_PROJECTION__` or
 * `localStorage["termihub.agentRenderFromProjection"]`.
 */
export function agentRenderFromProjectionEnabled(): boolean {
  if (renderFlagOverride !== null) return renderFlagOverride;
  try {
    if (typeof window !== "undefined") {
      const w = window as unknown as AgentRenderFlagWindow;
      if (typeof w.__TERMIHUB_AGENT_RENDER_FROM_PROJECTION__ === "boolean") {
        return w.__TERMIHUB_AGENT_RENDER_FROM_PROJECTION__;
      }
      const ls = w.localStorage?.getItem("termihub.agentRenderFromProjection");
      if (ls === "true") return true;
      if (ls === "false") return false;
    }
  } catch {
    // A missing/blocked window or storage just means "use the default".
  }
  return true;
}

// ── Mutation-cut feature flag (runtime-flippable, on by default) ───────────────

let mutationFlagOverride: boolean | null = null;

interface AgentMutationFlagWindow {
  __TERMIHUB_AGENT_INTENTS__?: boolean;
  localStorage?: Storage;
}

/**
 * Programmatic override for the mutation-cut flag (tests, and a runtime toggle).
 * `null` clears the override and falls back to the window/localStorage signal,
 * then to the default (on).
 */
export function setAgentIntentsEnabled(value: boolean | null): void {
  mutationFlagOverride = value;
}

/**
 * Whether the agent lifecycle actions (add/update/applySettings/remove/reorder/
 * toggleExpanded/connect/disconnect/shutdown/status/setCapabilities/refresh/
 * clearSessions and the definition/folder CRUD) dispatch granular `agent.*`
 * intents so the backend {@link import("../../src-tauri/src/agents_projection/store").AgentsStore}
 * is authoritative — instead of only the render-cut {@link seedAgentsRegion}
 * `agent.replace` mirror driving the region.
 *
 * **On by default** (#2226 mutation cut). When on, each action mirrors its
 * transition through an `agent.*` intent (via {@link mirrorAgentIntent}), and the
 * render-cut hook ({@link import("./useProjectedAgents").useProjectedAgents})
 * reflects the region back into the UI. The local `appStore` reducer path stays in
 * place as the render source and as a resilience / rollback fallback — any dispatch
 * failure is logged and the local mutation continues, so a backend hiccup can never
 * break the agent sidebar (the reducer removal is a later step). When off,
 * `appStore` drives the slice purely locally (the pre-cut path). The flip was taken
 * on the automated parity tests plus the instant local fallback, mirroring the
 * monitor mutation cut (#2224). Overridable at runtime for rollback / tests via
 * `window.__TERMIHUB_AGENT_INTENTS__` or `localStorage["termihub.agentIntents"]`
 * (set `"false"` to restore the pre-cut local-mutation path; `"true"` to force on).
 */
export function agentIntentsEnabled(): boolean {
  if (mutationFlagOverride !== null) return mutationFlagOverride;
  try {
    if (typeof window !== "undefined") {
      const w = window as unknown as AgentMutationFlagWindow;
      if (typeof w.__TERMIHUB_AGENT_INTENTS__ === "boolean") {
        return w.__TERMIHUB_AGENT_INTENTS__;
      }
      const ls = w.localStorage?.getItem("termihub.agentIntents");
      if (ls === "true") return true;
      if (ls === "false") return false;
    }
  } catch {
    // A missing/blocked window or storage just means "use the default".
  }
  return true;
}

// ── Transport + shared region client (lazy, mirrors the monitor slice) ─────────

let transportInstance: Transport | null = null;
let regionClient: ProjectionClient | null = null;
let startPromise: Promise<ProjectionClient> | null = null;

// A stable per-session client identity for dispatched intents (fan-out / audit
// only; the shared region's diff reaches every subscriber regardless of who
// dispatched it).
const clientId = newClientId();

/** Inject a transport for tests; `null` restores the lazily-created real one and
 * drops any active subscription / seed dedup. */
export function setAgentTransportForTest(t: Transport | null): void {
  regionClient?.stop();
  regionClient = null;
  startPromise = null;
  transportInstance = t;
  lastView = EMPTY_VIEW;
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
let lastView: AgentsView = EMPTY_VIEW;

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
 * and rethrown so the caller can fall back to `appStore`.
 */
export function ensureAgentsSubscribed(): Promise<ProjectionClient> {
  if (regionClient) return Promise.resolve(regionClient);
  if (!startPromise) {
    const client = new ProjectionClient(transport(), AGENTS_REGION);
    client.onChange((state) => {
      lastView = toView((state.view ?? {}) as AgentsRegionSnapshot);
      for (const listener of viewListeners) {
        try {
          listener(lastView);
        } catch (err) {
          logAgentBridgeFallback("reconcile", err);
        }
      }
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
  lastView = EMPTY_VIEW;
  lastSeededSignature = null;
}

/** The last view fanned out (for a hook that subscribes after the first diff). */
export function currentAgentsView(): AgentsView {
  return lastView;
}

// ── Seed: keep the region a faithful mirror of appStore (agent.replace) ────────

let lastSeededSignature: string | null = null;

/**
 * Seed the shared region with `appStore`'s whole agents slice via an
 * `agent.replace` intent, so the projection tracks `appStore`'s current state
 * while `appStore` stays authoritative (the render-side counterpart to the monitor
 * bridge's seed). The payload is keyed to the Rust snapshot shape
 * (`agents/sessions/definitions/folders`). De-duplicated: a slice identical to the
 * last seeded one is not re-dispatched. Never throws synchronously — a transport
 * that cannot dispatch surfaces as a rejected promise the caller logs and ignores
 * (staying on the `appStore` fallback). Idempotent server-side: replacing with the
 * same content yields no diff.
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
  // Set before dispatching so concurrent callers (sidebar + Open Connections) do
  // not double-dispatch the same seed.
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
 * The granular `agent.*` intent kinds the mutation cut dispatches (twins of the
 * Rust routes). Excludes `agent.replace`, which is the render-cut whole-slice
 * mirror ({@link seedAgentsRegion}); the mutation cut drives the region through
 * these per-transition intents instead so the store becomes authoritative.
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
 * Fire a granular `agent.*` intent to keep the backend store authoritative,
 * swallowing and logging any failure so the local `appStore` mutation path is
 * never disrupted by a bridge hiccup (the resilience fallback). A no-op when the
 * mutation cut is disabled ({@link agentIntentsEnabled} off — the rollback path).
 * Never throws — a synchronous transport-construction failure (non-Tauri, no
 * socket) is caught and logged, leaving the UI on the local slice. The twin of the
 * monitor bridge's {@link import("./systemMonitorBridge").dispatchMonitorIntentBestEffort}.
 */
export function mirrorAgentIntent(kind: AgentIntentKind, payload: Record<string, unknown>): void {
  if (!agentIntentsEnabled()) return;
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

// ── Faithful-mirror gate ───────────────────────────────────────────────────────

/**
 * Whether a projected `view` faithfully mirrors `appStore`'s agents slice — the
 * gate deciding whether the UI may render from the projection (true) or must fall
 * back to `appStore` (false). A deep value comparison of the ordered agent list
 * and the per-agent sessions/definitions/folders maps; because the projected
 * records match the frontend shapes one-to-one, a mirroring view is
 * value-identical to the `appStore` slice, so rendering from it can never diverge.
 *
 * The twin of the monitor render cut's `monitorsViewMirrors`.
 */
export function agentsViewMirrors(
  view: AgentsView | undefined,
  remoteAgents: RemoteAgentDefinition[],
  agentSessions: Record<string, AgentSessionInfo[]>,
  agentDefinitions: Record<string, AgentDefinitionInfo[]>,
  agentFolders: Record<string, AgentFolderInfo[]>
): boolean {
  if (!view) return false;
  return (
    deepEqual(view.remoteAgents, remoteAgents) &&
    deepEqual(view.agentSessions, agentSessions) &&
    deepEqual(view.agentDefinitions, agentDefinitions) &&
    deepEqual(view.agentFolders, agentFolders)
  );
}

/**
 * A structural deep-equal for the JSON-ish agents view model (objects, arrays, and
 * primitives — no functions/dates/maps). Numbers compare with `===`, so an integer
 * that round-tripped through JSON as a float (`40` vs `40.0`) still matches.
 * Exported for the bridge's parity tests.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const aKeys = Object.keys(ao);
    const bKeys = Object.keys(bo);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k])
    );
  }
  return false;
}

/** Log a bridge fallback so the appStore-path recovery is visible in the LogViewer. */
export function logAgentBridgeFallback(kind: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  frontendLog("agent_bridge", `${kind} fell back to appStore agents: ${message}`);
}
