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
import { makeVersionGuard } from "./bridgeVersionGuard";
import { errorMessage } from "@/utils/errorMessage";

/** The projection region id for a client's workflow run
 * (`workflow-run@<clientId>`, twin of the Rust `workflow_run_region`). */
export function workflowRunRegion(clientId: string): string {
  return `workflow-run@${clientId}`;
}

/** Keep only the most recent lines so a chatty local process stays bounded. */
const WORKFLOW_RUN_OUTPUT_MAX_LINES = 1000;

// ── Projected view model (twin of the Rust store snapshot) ─────────────────────

/** One in-flight run's step-progress, projected by the region — a one-to-one twin
 * of the frontend run-progress shape. Keyed by `runId` (#3418): several runs may
 * be in flight at once (a concurrent "Run on…" fan-out has one per target). */
export interface ProjectedWorkflowRun {
  /** The run's id (`"legacy"` for a run started without one). */
  runId: string;
  workflowId: string;
  workflowName: string;
  tabId: string;
  /** A human-readable name for the target (the terminal's title), when given. */
  label?: string | null;
  total: number;
  completed: number;
}

/** The inline run-output panel's *status* seam, projected by the region. The
 * streamed `lines` / `exitCode` / `timedOut` stay frontend (see the module docs),
 * so the projection carries only the panel's identity + status. */
export interface ProjectedWorkflowRunOutput {
  /** The run whose local process opened the panel (`null` for a legacy open). */
  runId?: string | null;
  workflowId: string;
  workflowName: string;
  program: string;
  args: string[];
  status: WorkflowRunOutputStatus;
  /** A human-readable failure reason (`failed` only); `null`/absent otherwise. */
  error?: string | null;
}

/** The `workflow-run@<clientId>` region view model: `{ run, runs, output }` (twin
 * of the Rust `ClientState::to_view`). `runs` lists every in-flight run in start
 * order (#3418); `run` is the most recently started one, kept for back-compat. */
export interface WorkflowRunView {
  run: ProjectedWorkflowRun | null;
  runs: ProjectedWorkflowRun[];
  output: ProjectedWorkflowRunOutput | null;
}

/** A view as a test (or a pre-#3418 backend) may supply it: `runs` optional —
 * {@link normalizeView} lifts a lone `run` into a one-entry list. */
export type WorkflowRunViewInput = Omit<WorkflowRunView, "runs"> & {
  runs?: ProjectedWorkflowRun[];
};

/** The empty view a fresh region reports (twin of the empty store snapshot). */
const EMPTY_VIEW: WorkflowRunView = { run: null, runs: [], output: null };

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
  versionGuard.reset();
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
// The monotonic region-version guard for `lastView` (FES-006): a projected view
// strictly older than the last applied is a stale, out-of-order delivery and is
// ignored, so it can never clobber a newer view.
const versionGuard = makeVersionGuard();

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

/** Coerce a raw region view to the {@link WorkflowRunView} shape (nulls / empty list
 * for absent halves), so a partial/empty snapshot never leaks `undefined` into the
 * hook. A pre-#3418 view carrying only `run` is lifted into a one-entry `runs`. */
function normalizeView(raw: unknown): WorkflowRunView {
  const view = (raw ?? EMPTY_VIEW) as Partial<WorkflowRunView>;
  const runs = Array.isArray(view.runs) ? view.runs : view.run ? [view.run] : [];
  const run = view.run ?? runs[runs.length - 1] ?? null;
  return { run, runs, output: view.output ?? null };
}

/**
 * Commit a projected view (at its region `version`) as the current view and fan it
 * out, unless it is stale (a version strictly older than the last applied). On
 * today's substrate versions arrive monotonically so the guard never drops a valid
 * update — it only adds out-of-order protection.
 */
function commitWorkflowRunView(view: WorkflowRunView, version: number): void {
  if (!versionGuard.shouldApply(version)) return;
  lastView = view;
  fanView();
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
      commitWorkflowRunView(normalizeView(state.view), state.version);
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
  versionGuard.reset();
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
  /** The run whose local process owns the buffer (#3418); absent for a legacy open. */
  runId?: string;
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
 * line buffer keyed to `workflowId` (and the owning `runId`), so a second spawn
 * shows its own process. */
export function openWorkflowOutputContent(workflowId: string, runId?: string): void {
  outputContent = { workflowId, runId, lines: [], exitCode: null, timedOut: false };
  fanContent();
}

/** True when a write tagged `runId` targets the open buffer: untagged writes (and
 * writes to an untagged buffer) always do; a tagged write to another run's buffer
 * is dropped, so a concurrent sibling's process never bleeds into it (#3418). */
function ownsContent(runId: string | undefined): boolean {
  if (!outputContent) return false;
  return runId === undefined || outputContent.runId === undefined || outputContent.runId === runId;
}

/** Append a streamed line to the open content buffer (a no-op when none is open or
 * it belongs to another run), trimming to the most recent
 * {@link WORKFLOW_RUN_OUTPUT_MAX_LINES}. */
export function appendWorkflowOutputLine(line: WorkflowRunOutputLine, runId?: string): void {
  if (!outputContent || !ownsContent(runId)) return;
  const lines = [...outputContent.lines, line];
  const trimmed =
    lines.length > WORKFLOW_RUN_OUTPUT_MAX_LINES
      ? lines.slice(lines.length - WORKFLOW_RUN_OUTPUT_MAX_LINES)
      : lines;
  outputContent = { ...outputContent, lines: trimmed };
  fanContent();
}

/** Record the process's raw exit outcome on the open content buffer. */
export function setWorkflowOutputProcessResult(
  exitCode: number | null,
  timedOut: boolean,
  runId?: string
): void {
  if (!outputContent || !ownsContent(runId)) return;
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

/** Dispatch `workflow.runStarted` (begin run `runId` at `completed == 0`). The
 * panel is cleared unless `preserveOutput` is set — a target of a concurrent
 * fan-out keeps a sibling's panel (#3418). */
export function dispatchWorkflowRunStarted(payload: {
  runId: string;
  workflowId: string;
  workflowName: string;
  tabId: string;
  total: number;
  label?: string;
  preserveOutput?: boolean;
}): Promise<void> {
  return dispatchWorkflow("workflow.runStarted", {
    runId: payload.runId,
    workflowId: payload.workflowId,
    workflowName: payload.workflowName,
    tabId: payload.tabId,
    total: payload.total,
    ...(payload.label !== undefined ? { label: payload.label } : {}),
    ...(payload.preserveOutput ? { preserveOutput: true } : {}),
  });
}

/** Dispatch `workflow.stepAdvanced` (update run `runId`'s progress while it is in
 * flight). */
export function dispatchWorkflowStepAdvanced(payload: {
  runId: string;
  workflowId: string;
  tabId: string;
  completed: number;
}): Promise<void> {
  return dispatchWorkflow("workflow.stepAdvanced", {
    runId: payload.runId,
    workflowId: payload.workflowId,
    tabId: payload.tabId,
    completed: payload.completed,
  });
}

/** Dispatch `workflow.outputOpened` (open the run-output panel in `running`, owned
 * by run `runId`). */
export function dispatchWorkflowOutputOpened(payload: {
  runId: string;
  workflowId: string;
  workflowName: string;
  program: string;
  args: string[];
}): Promise<void> {
  return dispatchWorkflow("workflow.outputOpened", {
    runId: payload.runId,
    workflowId: payload.workflowId,
    workflowName: payload.workflowName,
    program: payload.program,
    args: payload.args,
  });
}

/** Dispatch run `runId`'s terminal outcome (`completed` / `cancelled` / `failed`). */
export function dispatchWorkflowRunSettled(
  runId: string,
  status: WorkflowRunOutputStatus,
  error?: string
): Promise<void> {
  if (status === "completed") {
    return dispatchWorkflow("workflow.runCompleted", { runId });
  }
  if (status === "cancelled") {
    return dispatchWorkflow("workflow.runCancelled", { runId });
  }
  if (status === "failed") {
    return dispatchWorkflow(
      "workflow.runFailed",
      error !== undefined ? { runId, error } : { runId }
    );
  }
  return Promise.resolve();
}

/** Dispatch `workflow.dismissOutput` (dismiss the run-output panel). */
export function dispatchWorkflowDismissOutput(): Promise<void> {
  return dispatchWorkflow("workflow.dismissOutput", {});
}

/** Log a bridge issue so a projection hiccup is visible in the LogViewer. */
export function logWorkflowBridgeFallback(kind: string, err: unknown): void {
  const message = errorMessage(err);
  frontendLog("workflow_run_bridge", `${kind}: ${message}`);
}

// ── Test seams (drive the projected view + streamed content directly) ──────────

/** Push a projected view straight to the render hook (component tests that do not
 * stand up a transport double). */
export function setWorkflowRunViewForTest(view: WorkflowRunViewInput): void {
  lastView = normalizeView(view);
  fanView();
}

/** Commit a projected view at an explicit region `version` through the same guarded
 * path a real diff takes, so a test can drive the stale-drop / apply behaviour
 * (FES-006) without a transport double. Never call from production code. */
export function __emitWorkflowRunViewForTest(view: WorkflowRunViewInput, version: number): void {
  commitWorkflowRunView(normalizeView(view), version);
}

/** Push streamed content straight to the render hook (component tests). */
export function setWorkflowOutputContentForTest(content: WorkflowRunOutputContent | null): void {
  outputContent = content;
  fanContent();
}
