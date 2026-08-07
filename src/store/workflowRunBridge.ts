/**
 * Workflow-run projection bridge — the workflow-run machine's **authoritative**
 * region (#2206 step 5c reducer-removal, part of #2152 / #2139).
 *
 * The workflow-run **shadow** (PR #2256) landed a backend-authoritative,
 * client-scoped [`WorkflowRunStore`](../../src-tauri/src/workflow_projection/store.rs)
 * served as the `workflow-run@<clientId>` projection region, with `workflow.*`
 * intents (`runStarted` / `stepAdvanced` / `outputOpened` / `runCompleted` /
 * `runCancelled` / `runFailed` / `dismissOutput`). The render + mutation cuts
 * (#2243) then routed the UI through it behind flags, keeping the `appStore`
 * reducers as a parity-safe fallback. This step **removes that fallback**: the
 * region is now the single source of truth for the run's progress + the output
 * panel's status, the flags are gone, and `appStore` no longer holds a
 * workflow-run slice. This is the direct analog of the monitors ({@link
 * import("./systemMonitorBridge")}, #2224/#2376) and transfers ({@link
 * import("./transfersBridge")}, #2229/#2387) reducer-removals.
 *
 * # Two halves of the workflow-run state
 *
 * - **Projected status (authoritative).** The Workflow Manager's per-workflow
 *   "running" badge (run progress) and the inline run-output panel's live status
 *   (identity + `status` + `error`) come from the region. The run orchestration in
 *   `appStore.runWorkflow` drives the region by **reliably dispatching** the
 *   `workflow.*` intents (no flag gate, no local mirror) — the sole write path.
 * - **Streamed content (frontend-owned).** The run-output panel's streamed
 *   `lines` / `exitCode` / `timedOut` are high-frequency, local-process output the
 *   projection deliberately does not model (driving them through region diffs adds
 *   fragility with no parity benefit — Decision #4/#6 of the shadow). They live in
 *   this bridge's {@link WorkflowRunOutputContent} store, fanned out to the render
 *   hook alongside the projected view. Removing the `appStore` slice moved them
 *   here; they were never authoritative region state.
 *
 * {@link import("./useProjectedWorkflowRun").useProjectedWorkflowRun} subscribes to
 * both and merges the authoritative projected status with the frontend streamed
 * content.
 *
 * The transient progress toast (`toast.loading` step counter + the terminal
 * success/info/error toast) stays a **local side-effect notification** fired from
 * the `runWorkflow` orchestration: it is transient feedback threaded through the
 * run's async loop, not durable projected state.
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
import type { WorkflowRunOutputLine, WorkflowRunOutputStatus } from "@/store/appStore";
import { frontendLog } from "@/utils/frontendLog";

/** The projection region id for a client's workflow run
 * (`workflow-run@<clientId>`, twin of the Rust `workflow_run_region`). */
export function workflowRunRegion(clientId: string): string {
  return `workflow-run@${clientId}`;
}

/** Keep only the most recent lines so a chatty local process stays bounded. */
const WORKFLOW_RUN_OUTPUT_MAX_LINES = 1000;

// ── Projected view model (twin of the Rust store snapshot) ─────────────────────

/** The in-flight run's step-progress, projected by the region — a one-to-one twin
 * of the frontend run-progress shape. */
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
 * drops any active subscription, cached view, and streamed content. */
export function setWorkflowTransportForTest(t: Transport | null): void {
  regionClient?.stop();
  regionClient = null;
  startPromise = null;
  transportInstance = t;
  lastView = EMPTY_VIEW;
  outputContent = null;
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

function fanView(): void {
  for (const listener of viewListeners) {
    try {
      listener(lastView);
    } catch (err) {
      logWorkflowBridgeFallback("reconcile", err);
    }
  }
}

/** Coerce a raw region view to the {@link WorkflowRunView} shape (nulls for absent
 * halves), so a partial/empty snapshot never leaks `undefined` into the hook. */
function normalizeView(raw: unknown): WorkflowRunView {
  const view = (raw ?? EMPTY_VIEW) as Partial<WorkflowRunView>;
  return { run: view.run ?? null, output: view.output ?? null };
}

/**
 * Ensure the `workflow-run@<clientId>` region client is subscribed so projected
 * diffs are received and fanned out to the {@link onWorkflowRunView} listeners.
 * Idempotent and de-duplicated across concurrent callers; a transport/subscribe
 * failure is logged and rethrown so the caller can fall back to the empty view.
 */
export function ensureWorkflowSubscribed(): Promise<ProjectionClient> {
  if (regionClient) return Promise.resolve(regionClient);
  if (!startPromise) {
    const client = new ProjectionClient(transport(), region);
    client.onChange((state: ProjectionCacheState) => {
      lastView = normalizeView(state.view);
      fanView();
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

/** Drop the region subscription and reset the cached view (tests / re-init). */
export function stopWorkflowSubscription(): void {
  regionClient?.stop();
  regionClient = null;
  startPromise = null;
  lastView = EMPTY_VIEW;
}

// ── Frontend-owned streamed output content (not projected) ─────────────────────

/**
 * The run-output panel's frontend-owned streamed content: the accumulated
 * stdout/stderr `lines` and the process's raw `exitCode` / `timedOut`, keyed by
 * the `workflowId` whose local process produced them. The panel's *identity +
 * status* come from the projected region; this is the high-frequency content the
 * projection deliberately does not model (see the module docs).
 */
export interface WorkflowRunOutputContent {
  workflowId: string;
  lines: WorkflowRunOutputLine[];
  exitCode: number | null;
  timedOut: boolean;
}

let outputContent: WorkflowRunOutputContent | null = null;
const contentListeners = new Set<(content: WorkflowRunOutputContent | null) => void>();

/** Register a listener, invoked with the streamed content on every change. */
export function onWorkflowOutputContent(
  listener: (content: WorkflowRunOutputContent | null) => void
): () => void {
  contentListeners.add(listener);
  return () => contentListeners.delete(listener);
}

/** The current streamed content (for a hook that subscribes after a change). */
export function currentWorkflowOutputContent(): WorkflowRunOutputContent | null {
  return outputContent;
}

function fanContent(): void {
  for (const listener of contentListeners) {
    try {
      listener(outputContent);
    } catch (err) {
      logWorkflowBridgeFallback("content", err);
    }
  }
}

/** Open a fresh streamed-content buffer for a `run-local-process` spawn — a clean
 * line buffer keyed to `workflowId`, so a second spawn shows its own process. */
export function openWorkflowOutputContent(workflowId: string): void {
  outputContent = { workflowId, lines: [], exitCode: null, timedOut: false };
  fanContent();
}

/** Append a streamed line to the open content buffer (a no-op when none is open),
 * trimming to the most recent {@link WORKFLOW_RUN_OUTPUT_MAX_LINES}. */
export function appendWorkflowOutputLine(line: WorkflowRunOutputLine): void {
  if (!outputContent) return;
  const lines = [...outputContent.lines, line];
  const trimmed =
    lines.length > WORKFLOW_RUN_OUTPUT_MAX_LINES
      ? lines.slice(lines.length - WORKFLOW_RUN_OUTPUT_MAX_LINES)
      : lines;
  outputContent = { ...outputContent, lines: trimmed };
  fanContent();
}

/** Record the process's raw exit outcome on the open content buffer. */
export function setWorkflowOutputProcessResult(exitCode: number | null, timedOut: boolean): void {
  if (!outputContent) return;
  outputContent = { ...outputContent, exitCode, timedOut };
  fanContent();
}

/** Clear the streamed content (a fresh run start, or the panel is dismissed). */
export function clearWorkflowOutputContent(): void {
  if (outputContent === null) return;
  outputContent = null;
  fanContent();
}

// ── Reliable intent dispatch (the sole write path) ─────────────────────────────

/** The `workflow.*` intent kinds the orchestration dispatches (twins of the Rust
 * routes). */
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
 * Dispatch a `workflow.*` intent as the authoritative write, keeping the region
 * subscription warm so the resulting diff reaches the render hook. The `transport`
 * call submits the intent synchronously (before it awaits the ack), so successive
 * calls apply in call order. A rejected ack or a transport failure is logged (so
 * the LogViewer shows a projection hiccup) but never thrown — a backend stumble
 * must not crash a workflow run mid-flight.
 */
async function dispatchWorkflow(
  kind: WorkflowIntentKind,
  payload: Record<string, unknown>
): Promise<void> {
  // Keep the subscription warm so region diffs reach the render hook. Guarded
  // because a non-Tauri env without a socket throws *synchronously* from transport
  // construction (not as a rejection); the dispatch below then logs + no-ops.
  try {
    void ensureWorkflowSubscribed().catch(() => {
      /* logged in ensureWorkflowSubscribed */
    });
  } catch {
    /* handled by the dispatch try/catch below */
  }
  try {
    const ack = await dispatchWorkflowIntent(kind, payload);
    if (ack.status === "rejected") {
      logWorkflowBridgeFallback(kind, new Error(ack.error?.message ?? "rejected"));
    }
  } catch (err) {
    logWorkflowBridgeFallback(kind, err);
  }
}

/** Dispatch `workflow.runStarted` (begin a run at `completed == 0`; clears panel). */
export function dispatchWorkflowRunStarted(payload: {
  workflowId: string;
  workflowName: string;
  tabId: string;
  total: number;
}): Promise<void> {
  return dispatchWorkflow("workflow.runStarted", {
    workflowId: payload.workflowId,
    workflowName: payload.workflowName,
    tabId: payload.tabId,
    total: payload.total,
  });
}

/** Dispatch `workflow.stepAdvanced` (update progress when the ids still match). */
export function dispatchWorkflowStepAdvanced(payload: {
  workflowId: string;
  tabId: string;
  completed: number;
}): Promise<void> {
  return dispatchWorkflow("workflow.stepAdvanced", {
    workflowId: payload.workflowId,
    tabId: payload.tabId,
    completed: payload.completed,
  });
}

/** Dispatch `workflow.outputOpened` (open the run-output panel in `running`). */
export function dispatchWorkflowOutputOpened(payload: {
  workflowId: string;
  workflowName: string;
  program: string;
  args: string[];
}): Promise<void> {
  return dispatchWorkflow("workflow.outputOpened", {
    workflowId: payload.workflowId,
    workflowName: payload.workflowName,
    program: payload.program,
    args: payload.args,
  });
}

/** Dispatch a run's terminal outcome (`completed` / `cancelled` / `failed`). */
export function dispatchWorkflowRunSettled(
  status: WorkflowRunOutputStatus,
  error?: string
): Promise<void> {
  if (status === "completed") {
    return dispatchWorkflow("workflow.runCompleted", {});
  }
  if (status === "cancelled") {
    return dispatchWorkflow("workflow.runCancelled", {});
  }
  if (status === "failed") {
    return dispatchWorkflow("workflow.runFailed", error !== undefined ? { error } : {});
  }
  return Promise.resolve();
}

/** Dispatch `workflow.dismissOutput` (dismiss the run-output panel). */
export function dispatchWorkflowDismissOutput(): Promise<void> {
  return dispatchWorkflow("workflow.dismissOutput", {});
}

/** Log a bridge issue so a projection hiccup is visible in the LogViewer. */
export function logWorkflowBridgeFallback(kind: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  frontendLog("workflow_run_bridge", `${kind}: ${message}`);
}

// ── Test seams (drive the projected view + streamed content directly) ──────────

/** Push a projected view straight to the render hook (component tests that do not
 * stand up a transport double). */
export function setWorkflowRunViewForTest(view: WorkflowRunView): void {
  lastView = normalizeView(view);
  fanView();
}

/** Push streamed content straight to the render hook (component tests). */
export function setWorkflowOutputContentForTest(content: WorkflowRunOutputContent | null): void {
  outputContent = content;
  fanContent();
}
