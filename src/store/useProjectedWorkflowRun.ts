/**
 * `useProjectedWorkflowRun` — the Workflow Manager cut to the projected
 * `workflow-run@<clientId>` region (#2243 render cut, part of #2206 / #2139).
 *
 * The Workflow Manager renders a per-workflow "running" badge (from
 * `appStore.workflowRun`) and the inline run-output panel's live status (from
 * `appStore.workflowRunOutput`). Through the shadow step both read `appStore`
 * directly. This hook makes them source the run progress + output-panel status from
 * the client-scoped `workflow-run` projection region instead — the direct analog of
 * {@link import("./useProjectedMonitors").useProjectedMonitors} (#2224) and
 * {@link import("./useLayoutRenderTree").useLayoutRenderTree} (#2151).
 *
 * # Safety (strangler)
 *
 * - **Gated** by {@link workflowRenderFromProjectionEnabled} (on by default). Flag
 *   off ⇒ the hook returns `appStore`'s slice verbatim.
 * - **Faithful-mirror gate.** The projection sources the render only when it mirrors
 *   the `appStore` run + output status seam ({@link workflowRunMirrors}); otherwise
 *   the hook falls back to `appStore` (never a stale view). The region is kept
 *   populated by the `workflow.*` mirror intents the `runWorkflow` reducer dispatches
 *   whenever either flag is on, so the cut is parity-safe and independent of the
 *   mutation flag.
 * - **Streamed output stays frontend.** The projection models only the panel's
 *   *status* seam; the streamed `lines` / `exitCode` / `timedOut` are kept from
 *   `appStore` and merged back in when rendering from the region (matching the
 *   shadow's frontend-owned boundary).
 */

import { useEffect, useMemo, useState } from "react";

import { useAppStore, type WorkflowRunOutputState, type WorkflowRunState } from "@/store/appStore";
import {
  currentWorkflowRunView,
  ensureWorkflowSubscribed,
  logWorkflowBridgeFallback,
  onWorkflowRunView,
  workflowRenderFromProjectionEnabled,
  workflowRunMirrors,
  type WorkflowRunView,
} from "@/store/workflowRunBridge";

/** The effective workflow-run slice for rendering: `workflowRun` (run progress) +
 * `workflowRunOutput` (the run-output panel). */
export interface ProjectedWorkflowRunSlice {
  workflowRun: WorkflowRunState | null;
  workflowRunOutput: WorkflowRunOutputState | null;
}

/**
 * The effective workflow-run slice for rendering, sourced from the projected
 * `workflow-run@<clientId>` region when it faithfully mirrors `appStore`, otherwise
 * `appStore`'s slice verbatim (flag off, region not yet caught up, or a transport
 * that cannot subscribe).
 *
 * When rendering from the region, the run progress comes wholly from the projection
 * (a one-to-one twin), while the output panel merges the projected identity/status
 * with `appStore`'s frontend-owned streamed `lines` / `exitCode` / `timedOut`.
 */
export function useProjectedWorkflowRun(): ProjectedWorkflowRunSlice {
  const workflowRun = useAppStore((s) => s.workflowRun);
  const workflowRunOutput = useAppStore((s) => s.workflowRunOutput);

  // Read the flag once at mount: it flips only via dev tooling, and the
  // subscription lifecycle is keyed off it below.
  const [enabled] = useState(() => workflowRenderFromProjectionEnabled());

  const [view, setView] = useState<WorkflowRunView | undefined>(undefined);

  // Subscribe to the client-scoped workflow-run region while enabled; a transport
  // that cannot subscribe (non-Tauri without a socket) just leaves the UI on the
  // appStore fallback.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const unsubscribe = onWorkflowRunView((next) => {
      if (!cancelled) setView(next);
    });
    try {
      ensureWorkflowSubscribed()
        .then(() => {
          if (!cancelled) setView(currentWorkflowRunView());
        })
        .catch((err) => logWorkflowBridgeFallback("subscribe", err));
    } catch (err) {
      logWorkflowBridgeFallback("subscribe", err);
    }
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [enabled]);

  const outputSeam = workflowRunOutput
    ? {
        workflowId: workflowRunOutput.workflowId,
        workflowName: workflowRunOutput.workflowName,
        program: workflowRunOutput.program,
        args: workflowRunOutput.args,
        status: workflowRunOutput.status,
        error: workflowRunOutput.error,
      }
    : null;

  const matches = enabled && workflowRunMirrors(view, workflowRun, outputSeam);

  return useMemo(() => {
    if (!matches || !view) {
      return { workflowRun, workflowRunOutput };
    }
    // Render from the region. Run progress is a one-to-one twin; the output panel
    // takes its identity + status from the projection and keeps the frontend-owned
    // streamed content from appStore (the gate guarantees these agree, so the merge
    // is byte-identical to appStore).
    const projectedOutput: WorkflowRunOutputState | null =
      view.output && workflowRunOutput
        ? {
            workflowId: view.output.workflowId,
            workflowName: view.output.workflowName,
            program: view.output.program,
            args: view.output.args,
            status: view.output.status,
            error: view.output.error ?? undefined,
            lines: workflowRunOutput.lines,
            exitCode: workflowRunOutput.exitCode,
            timedOut: workflowRunOutput.timedOut,
          }
        : null;
    return { workflowRun: view.run, workflowRunOutput: projectedOutput };
  }, [matches, view, workflowRun, workflowRunOutput]);
}
