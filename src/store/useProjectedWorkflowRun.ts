/**
 * `useProjectedWorkflowRun` — read the authoritative `workflow-run@<clientId>`
 * region (#2206 step 5c reducer-removal, part of #2139).
 *
 * The Workflow Manager renders a per-workflow "running" badge (run progress) and
 * the inline run-output panel's live status. Both now source that state from the
 * client-scoped `workflow-run` projection region, which is **authoritative**: the
 * run orchestration in `appStore.runWorkflow` drives it by reliably dispatching the
 * `workflow.*` intents, and `appStore` no longer holds a workflow-run slice. This
 * is the direct analog of {@link import("./useProjectedMonitors").useProjectedMonitors}
 * (#2224) and {@link import("./useProjectedTransfers").useProjectedTransfers} (#2229).
 *
 * The hook subscribes to the region (one shared subscription, fanned out by the
 * bridge) and to the bridge's frontend-owned streamed-content store, and merges
 * them: run progress + the output panel's identity/status come from the projection
 * (the single source of truth); the output panel's streamed `lines` / `exitCode` /
 * `timedOut` come from the content store (high-frequency local-process output the
 * projection deliberately does not model). There is no `appStore` fallback and no
 * mirror gate — the region is the source of truth.
 */

import { useEffect, useMemo, useState } from "react";

import type { WorkflowRunOutputState, WorkflowRunState } from "@/store/appStore";
import {
  currentWorkflowOutputContent,
  currentWorkflowRunView,
  ensureWorkflowSubscribed,
  logWorkflowBridgeFallback,
  onWorkflowOutputContent,
  onWorkflowRunView,
  type WorkflowRunOutputContent,
  type WorkflowRunView,
} from "@/store/workflowRunBridge";

/** The effective workflow-run slice for rendering: `workflowRun` (run progress) +
 * `workflowRunOutput` (the run-output panel). */
export interface ProjectedWorkflowRunSlice {
  workflowRun: WorkflowRunState | null;
  workflowRunOutput: WorkflowRunOutputState | null;
}

/**
 * The current workflow-run slice for rendering, sourced from the authoritative
 * `workflow-run@<clientId>` projection region (run progress + output-panel status)
 * merged with the bridge's frontend-owned streamed content (`lines` / `exitCode` /
 * `timedOut`).
 */
export function useProjectedWorkflowRun(): ProjectedWorkflowRunSlice {
  const [view, setView] = useState<WorkflowRunView>(() => currentWorkflowRunView());
  const [content, setContent] = useState<WorkflowRunOutputContent | null>(() =>
    currentWorkflowOutputContent()
  );

  useEffect(() => {
    let cancelled = false;
    const unsubscribeView = onWorkflowRunView((next) => {
      if (!cancelled) setView(next);
    });
    const unsubscribeContent = onWorkflowOutputContent((next) => {
      if (!cancelled) setContent(next);
    });
    // `ensureWorkflowSubscribed` builds the transport eagerly, so a non-Tauri env
    // without a socket throws synchronously (not just a rejection) — guard both so
    // the hook silently stays on the last-known (or empty) view.
    try {
      ensureWorkflowSubscribed()
        .then(() => {
          if (!cancelled) {
            setView(currentWorkflowRunView());
            setContent(currentWorkflowOutputContent());
          }
        })
        .catch((err) => logWorkflowBridgeFallback("subscribe", err));
    } catch (err) {
      logWorkflowBridgeFallback("subscribe", err);
    }
    return () => {
      cancelled = true;
      unsubscribeView();
      unsubscribeContent();
    };
  }, []);

  return useMemo(() => {
    const workflowRun: WorkflowRunState | null = view.run;
    const output = view.output;
    if (!output) {
      return { workflowRun, workflowRunOutput: null };
    }
    // Merge the projected identity/status with the frontend-owned streamed content
    // (matched by workflowId; empty defaults until the content buffer opens).
    const streamed = content && content.workflowId === output.workflowId ? content : null;
    const workflowRunOutput: WorkflowRunOutputState = {
      workflowId: output.workflowId,
      workflowName: output.workflowName,
      program: output.program,
      args: output.args,
      status: output.status,
      error: output.error ?? undefined,
      lines: streamed?.lines ?? [],
      exitCode: streamed?.exitCode ?? null,
      timedOut: streamed?.timedOut ?? false,
    };
    return { workflowRun, workflowRunOutput };
  }, [view, content]);
}
