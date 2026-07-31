/**
 * Workflow-run projection bridge — Phase 4 step 5c render + mutation cut of the
 * workflow-run machine (#2243, part of #2206 / #2152 / #2139).
 *
 * The workflow-run **shadow** (PR #2256) landed a backend-authoritative,
 * client-scoped [`WorkflowRunStore`](../../src-tauri/src/workflow_projection/store.rs)
 * served as the `workflow-run@<clientId>` projection region, with `workflow.*`
 * intents (`runStarted` / `stepAdvanced` / `outputOpened` / `runCompleted` /
 * `runCancelled` / `runFailed` / `dismissOutput`), but nothing in the UI touched
 * it. This step cuts the live UI over to it — the sibling of the restore-cohort
 * cut ({@link import("./restoreCohortBridge")}, #2241) and the monitor render +
 * mutation cuts ({@link import("./systemMonitorBridge")}, #2224).
 *
 * Unlike restore-cohort's single fire-once settlement toast, the workflow-run
 * render surface is **durable rendered state**: the Workflow Manager's per-workflow
 * "running" badge (from `appStore.workflowRun`) and the inline run-output panel's
 * live status (from `appStore.workflowRunOutput`). So the render cut is a
 * declarative one — the direct analog of the monitors/agents cut: a hook
 * ({@link import("./useProjectedWorkflowRun").useProjectedWorkflowRun}) reads the
 * projected region and renders from it **only when it faithfully mirrors**
 * `appStore` ({@link workflowRunMirrors}); otherwise it falls back to `appStore`
 * verbatim, so the rendered output is byte-identical to the pre-cut path.
 *
 * The transient progress toast (`toast.loading` step counter + the terminal
 * success/info/error toast) stays a **local side-effect notification** fired from
 * the `runWorkflow` reducer: it is transient feedback threaded through the run's
 * async loop, not durable projected state, so driving it from the region would add
 * fragility with no parity benefit. Recorded here as Decision #4/#6 of this cut.
 *
 * # Two independent flags, both on by default
 *
 * - {@link workflowRenderFromProjectionEnabled} (render cut) — when on, the running
 *   badge + output-panel status render from the projected region when it mirrors
 *   `appStore`, else fall back. Parity-safe: the mirror gate guarantees the
 *   projected view deep-equals the rendered slice.
 * - {@link workflowIntentsEnabled} (mutation cut) — when on, the run transitions
 *   dispatch `workflow.*` intents so the backend store is authoritative. The local
 *   `appStore` reducers stay in place as the render source and the resilience /
 *   rollback fallback (removal is a later step); a dispatch failure is logged and
 *   the local mutation continues, so a backend hiccup can never break a run.
 *
 * The `workflow.*` mirror intents are dispatched whenever **either** flag is on
 * ({@link shouldMirrorWorkflow}); that keeps the render cut independent of the
 * mutation flag (the region is always populated when rendering from it — the same
 * shared-dispatch model restore-cohort uses). Overridable at runtime for rollback /
 * tests via `window.__TERMIHUB_WORKFLOW_RENDER__` /
 * `localStorage["termihub.workflowRender"]` and `window.__TERMIHUB_WORKFLOW_INTENTS__`
 * / `localStorage["termihub.workflowIntents"]` (set `"false"` to restore the pre-cut
 * local path).
 */

import {
  createTransport,
  newClientId,
  newIntentId,
  ProjectionClient,
  type IntentAck,
  type ProjectionCacheState,
  type Transport,
} from "@/services/transport";
import type { WorkflowRunOutputStatus, WorkflowRunState } from "@/store/appStore";
import { frontendLog } from "@/utils/frontendLog";

/** The projection region id for a client's workflow run
 * (`workflow-run@<clientId>`, twin of the Rust `workflow_run_region`). */
export function workflowRunRegion(clientId: string): string {
  return `workflow-run@${clientId}`;
}

// ── Projected view model (twin of the Rust store snapshot) ─────────────────────

/** The in-flight run's step-progress, projected by the region — a one-to-one twin
 * of the frontend {@link WorkflowRunState}. */
export interface ProjectedWorkflowRun {
  workflowId: string;
  workflowName: string;
  tabId: string;
  total: number;
  completed: number;
}

/** The inline run-output panel's *status* seam, projected by the region. The
 * streamed `lines` / `exitCode` / `timedOut` stay frontend (see the module docs),
 * so the projection carries only the panel's identity + status. */
export interface ProjectedWorkflowRunOutput {
  workflowId: string;
  workflowName: string;
  program: string;
  args: string[];
  status: WorkflowRunOutputStatus;
  /** A human-readable failure reason (`failed` only); `null`/absent otherwise. */
  error?: string | null;
}

/** The `workflow-run@<clientId>` region view model: `{ run, output }` (twin of the
 * Rust `ClientState::to_view`). */
export interface WorkflowRunView {
  run: ProjectedWorkflowRun | null;
  output: ProjectedWorkflowRunOutput | null;
}

/** The empty view a fresh region reports (twin of the empty store snapshot). */
const EMPTY_VIEW: WorkflowRunView = { run: null, output: null };

// ── Feature flags (runtime-flippable so a dev build can verify either path) ────

interface WorkflowFlagWindow {
  __TERMIHUB_WORKFLOW_RENDER__?: boolean;
  __TERMIHUB_WORKFLOW_INTENTS__?: boolean;
  localStorage?: Storage;
}

let renderFlagOverride: boolean | null = null;
let intentsFlagOverride: boolean | null = null;

/** Programmatic override for the render-cut flag (tests, runtime toggle). `null`
 * clears it and falls back to the window/localStorage signal, then the default. */
export function setWorkflowRenderFromProjectionEnabled(value: boolean | null): void {
  renderFlagOverride = value;
}

/** Programmatic override for the mutation-cut flag (tests, runtime toggle). */
export function setWorkflowIntentsEnabled(value: boolean | null): void {
  intentsFlagOverride = value;
}

/** Read a boolean feature signal from `window`/`localStorage`, else `dflt`. */
function readFlag(
  override: boolean | null,
  windowKey: keyof WorkflowFlagWindow,
  storageKey: string,
  dflt: boolean
): boolean {
  if (override !== null) return override;
  try {
    if (typeof window !== "undefined") {
      const w = window as unknown as WorkflowFlagWindow;
      const wv = w[windowKey];
      if (typeof wv === "boolean") return wv;
      const ls = w.localStorage?.getItem(storageKey);
      if (ls === "true") return true;
      if (ls === "false") return false;
    }
  } catch {
    // A missing/blocked window or storage just means "use the default".
  }
  return dflt;
}

/**
 * Whether the running badge + output-panel status render from the projected
 * `workflow-run@<clientId>` region instead of straight from `appStore` (render cut).
 *
 * **On by default.** Parity-safe: the hook renders from the region only when it
 * faithfully mirrors `appStore` ({@link workflowRunMirrors}), else falls back to
 * `appStore` verbatim, so the output is byte-identical to the pre-cut path.
 * Independent of the mutation cut — the region is populated whenever either flag is
 * on. Overridable via `window.__TERMIHUB_WORKFLOW_RENDER__` /
 * `localStorage["termihub.workflowRender"]`.
 */
export function workflowRenderFromProjectionEnabled(): boolean {
  return readFlag(
    renderFlagOverride,
    "__TERMIHUB_WORKFLOW_RENDER__",
    "termihub.workflowRender",
    true
  );
}

/**
 * Whether the run transitions dispatch `workflow.*` intents so the backend
 * {@link import("../../src-tauri/src/workflow_projection/store").WorkflowRunStore}
 * is authoritative (mutation cut).
 *
 * **On by default.** The local `appStore` reducers stay in place as the render
 * source and the resilience / rollback fallback (removal is a later step) — a
 * dispatch failure is logged and the local mutation continues, so a backend hiccup
 * can never break a workflow run. Overridable via
 * `window.__TERMIHUB_WORKFLOW_INTENTS__` / `localStorage["termihub.workflowIntents"]`.
 */
export function workflowIntentsEnabled(): boolean {
  return readFlag(
    intentsFlagOverride,
    "__TERMIHUB_WORKFLOW_INTENTS__",
    "termihub.workflowIntents",
    true
  );
}

/** The `workflow.*` mirror intents are dispatched whenever either flag is on: the
 * mutation cut needs them for authority, and the render cut needs them to keep the
 * region populated (making the render cut independent of the mutation flag). */
function shouldMirrorWorkflow(): boolean {
  return workflowIntentsEnabled() || workflowRenderFromProjectionEnabled();
}

// ── Transport + client-scoped region client (lazy, mirrors the layout slice) ───

// A stable per-session client identity. The client-scoped region is
// `workflow-run@<clientId>`, and dispatched intents carry the same id, so this
// checkout mutates and subscribes to its own workflow-run region.
const clientId = newClientId();
const region = workflowRunRegion(clientId);

let transportInstance: Transport | null = null;
let regionClient: ProjectionClient | null = null;
let startPromise: Promise<ProjectionClient> | null = null;

/** Inject a transport for tests; `null` restores the lazily-created real one and
 * drops any active subscription and cached view. */
export function setWorkflowTransportForTest(t: Transport | null): void {
  regionClient?.stop();
  regionClient = null;
  startPromise = null;
  transportInstance = t;
  lastView = EMPTY_VIEW;
}

function transport(): Transport {
  if (!transportInstance) {
    transportInstance = createTransport();
  }
  return transportInstance;
}

// ── View fan-out (one subscription, many consuming hooks) ──────────────────────

/** A change listener for the projected `workflow-run` view. */
export type WorkflowRunViewListener = (view: WorkflowRunView) => void;

const viewListeners = new Set<WorkflowRunViewListener>();
let lastView: WorkflowRunView = EMPTY_VIEW;

/**
 * Register a listener, invoked with the projected view on every diff. Returns an
 * unsubscribe. The region client is started on first {@link ensureWorkflowSubscribed}.
 */
export function onWorkflowRunView(listener: WorkflowRunViewListener): () => void {
  viewListeners.add(listener);
  return () => viewListeners.delete(listener);
}

/** The last view fanned out (for a hook that subscribes after the first diff). */
export function currentWorkflowRunView(): WorkflowRunView {
  return lastView;
}

/** Coerce a raw region view to the {@link WorkflowRunView} shape (nulls for absent
 * halves), so a partial/empty snapshot never leaks `undefined` into the gate. */
function normalizeView(raw: unknown): WorkflowRunView {
  const view = (raw ?? EMPTY_VIEW) as Partial<WorkflowRunView>;
  return { run: view.run ?? null, output: view.output ?? null };
}

/**
 * Ensure the `workflow-run@<clientId>` region client is subscribed so projected
 * diffs are received and fanned out to the {@link onWorkflowRunView} listeners.
 * Idempotent and de-duplicated across concurrent callers; a transport/subscribe
 * failure is logged and rethrown so the caller can fall back to `appStore`.
 */
export function ensureWorkflowSubscribed(): Promise<ProjectionClient> {
  if (regionClient) return Promise.resolve(regionClient);
  if (!startPromise) {
    const client = new ProjectionClient(transport(), region);
    client.onChange((state: ProjectionCacheState) => {
      lastView = normalizeView(state.view);
      for (const listener of viewListeners) {
        try {
          listener(lastView);
        } catch (err) {
          logWorkflowBridgeFallback("reconcile", err);
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
        logWorkflowBridgeFallback("subscribe", err);
        throw err;
      });
  }
  return startPromise;
}

/** Drop the region subscription (tests / re-init). */
export function stopWorkflowSubscription(): void {
  regionClient?.stop();
  regionClient = null;
  startPromise = null;
  lastView = EMPTY_VIEW;
}

// ── Faithful-mirror gate (render cut) ──────────────────────────────────────────

/** Ordered string-array equality (args are position-significant). */
function sameArgs(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/** Whether the projected `run` faithfully mirrors `appStore.workflowRun` — an
 * exact field-for-field match (both null counts as a mirror). */
function runMirrors(
  projected: ProjectedWorkflowRun | null,
  local: WorkflowRunState | null
): boolean {
  if (projected === null || local === null) return projected === null && local === null;
  return (
    projected.workflowId === local.workflowId &&
    projected.workflowName === local.workflowName &&
    projected.tabId === local.tabId &&
    projected.total === local.total &&
    projected.completed === local.completed
  );
}

/** Whether the projected `output` faithfully mirrors the *status seam* of
 * `appStore.workflowRunOutput` — identity + status + error. The streamed
 * `lines` / `exitCode` / `timedOut` stay frontend and are deliberately not
 * compared (the store does not model them). `error` is normalised so the store's
 * `null` and `appStore`'s `undefined` compare equal. */
function outputMirrors(
  projected: ProjectedWorkflowRunOutput | null,
  local: WorkflowRunOutputStatusSeam | null
): boolean {
  if (projected === null || local === null) return projected === null && local === null;
  return (
    projected.workflowId === local.workflowId &&
    projected.workflowName === local.workflowName &&
    projected.program === local.program &&
    sameArgs(projected.args, local.args) &&
    projected.status === local.status &&
    (projected.error ?? null) === (local.error ?? null)
  );
}

/** The subset of `appStore.workflowRunOutput` the projection models (its status
 * seam); the frontend keeps the streamed content alongside it. */
export interface WorkflowRunOutputStatusSeam {
  workflowId: string;
  workflowName: string;
  program: string;
  args: string[];
  status: WorkflowRunOutputStatus;
  error?: string;
}

/**
 * Whether the whole projected view faithfully mirrors `appStore`'s run + output
 * status seam — the render-cut gate. When true the hook renders from the region
 * (byte-identical to `appStore`); when false it falls back to `appStore` verbatim
 * (flag off, region not yet caught up, or a transport that cannot subscribe).
 */
export function workflowRunMirrors(
  view: WorkflowRunView | undefined,
  run: WorkflowRunState | null,
  output: WorkflowRunOutputStatusSeam | null
): boolean {
  if (!view) return false;
  return runMirrors(view.run, run) && outputMirrors(view.output, output);
}

// ── Mutation cut: workflow.* intent dispatch (also seeds the render region) ─────

/** The `workflow.*` intent kinds the cut dispatches (twins of the Rust routes). */
export type WorkflowIntentKind =
  | "workflow.runStarted"
  | "workflow.stepAdvanced"
  | "workflow.outputOpened"
  | "workflow.runCompleted"
  | "workflow.runCancelled"
  | "workflow.runFailed"
  | "workflow.dismissOutput";

/** Dispatch a `workflow.*` intent, resolving with the ack (parity tests). */
export function dispatchWorkflowIntent(
  kind: WorkflowIntentKind,
  payload: Record<string, unknown>
): Promise<IntentAck> {
  return transport().dispatch({ intentId: newIntentId(), kind, payload, clientId });
}

/**
 * Fire a `workflow.*` mirror intent to keep the backend store authoritative and
 * the render region populated, swallowing and logging any failure so the local
 * `appStore` mutation path is never disrupted by a bridge hiccup (the resilience
 * fallback). A no-op when both flags are off (pure rollback). Never throws — a
 * synchronous transport-construction failure (non-Tauri, no socket) is caught and
 * logged, leaving the UI on the local slice. Keeps the subscription warm so the
 * render cut receives the resulting diff.
 */
function mirrorWorkflow(kind: WorkflowIntentKind, payload: Record<string, unknown>): void {
  if (!shouldMirrorWorkflow()) return;
  // Keep the subscription warm so region diffs reach the render hook. Guarded
  // because a non-Tauri env without a socket throws *synchronously* from transport
  // construction (not as a rejection) — the dispatch below then logs + falls back.
  try {
    void ensureWorkflowSubscribed().catch(() => {
      /* logged in ensureWorkflowSubscribed; the local reducer already rendered */
    });
  } catch {
    /* handled by the dispatch try/catch below */
  }
  try {
    void dispatchWorkflowIntent(kind, payload)
      .then((ack) => {
        if (ack.status === "rejected") {
          logWorkflowBridgeFallback(kind, new Error(ack.error?.message ?? "rejected"));
        }
      })
      .catch((err) => logWorkflowBridgeFallback(kind, err));
  } catch (err) {
    logWorkflowBridgeFallback(kind, err);
  }
}

/** Mirror `workflow.runStarted` (begin a run at `completed == 0`; clears panel). */
export function mirrorWorkflowRunStarted(payload: {
  workflowId: string;
  workflowName: string;
  tabId: string;
  total: number;
}): void {
  mirrorWorkflow("workflow.runStarted", {
    workflowId: payload.workflowId,
    workflowName: payload.workflowName,
    tabId: payload.tabId,
    total: payload.total,
  });
}

/** Mirror `workflow.stepAdvanced` (update progress when the ids still match). */
export function mirrorWorkflowStepAdvanced(payload: {
  workflowId: string;
  tabId: string;
  completed: number;
}): void {
  mirrorWorkflow("workflow.stepAdvanced", {
    workflowId: payload.workflowId,
    tabId: payload.tabId,
    completed: payload.completed,
  });
}

/** Mirror `workflow.outputOpened` (open the run-output panel in `running`). */
export function mirrorWorkflowOutputOpened(payload: {
  workflowId: string;
  workflowName: string;
  program: string;
  args: string[];
}): void {
  mirrorWorkflow("workflow.outputOpened", {
    workflowId: payload.workflowId,
    workflowName: payload.workflowName,
    program: payload.program,
    args: payload.args,
  });
}

/** Mirror a run's terminal outcome (`completed` / `cancelled` / `failed`). */
export function mirrorWorkflowRunSettled(status: WorkflowRunOutputStatus, error?: string): void {
  if (status === "completed") {
    mirrorWorkflow("workflow.runCompleted", {});
  } else if (status === "cancelled") {
    mirrorWorkflow("workflow.runCancelled", {});
  } else if (status === "failed") {
    mirrorWorkflow("workflow.runFailed", error !== undefined ? { error } : {});
  }
}

/** Mirror `workflow.dismissOutput` (dismiss the run-output panel). */
export function mirrorWorkflowDismissOutput(): void {
  mirrorWorkflow("workflow.dismissOutput", {});
}

/** Log a bridge fallback so the local-path recovery is visible in the LogViewer. */
export function logWorkflowBridgeFallback(kind: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  frontendLog("workflow_run_bridge", `${kind} fell back to local workflow run: ${message}`);
}
