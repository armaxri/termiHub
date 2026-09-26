/**
 * Helpers for recording and exporting network-tool runs (PROD-032).
 *
 * Panels describe a finished run as a {@link RunSnapshot} (params, summary,
 * result table); these helpers stamp it with an id, timing and run location and
 * hand it to the history store. The backend enforces the real bounds; the
 * frontend only caps how many rows it ships over IPC.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useNetworkToolHistoryStore } from "@/store/networkToolHistoryStore";
import { useRunLocationStore } from "@/store/runLocationStore";
import type {
  DiagnosticStatus,
  NetworkHistoryTool,
  NetworkRunStatus,
  NetworkToolRun,
} from "@/types/network";
import { THIS_COMPUTER, type RunLocation } from "@/utils/runLocation";
import { tableToCsv, type ResultTable } from "./exportResults";

/** Rows sent to the backend per run; the backend trims further to its byte cap. */
export const MAX_HISTORY_ROWS = 2000;

/** A run parameter value (the params object is plain JSON). */
export type RunParam = string | number | boolean | null;

/** What a panel knows about a run when it finishes. */
export interface RunSnapshot {
  /** The tool's inputs, enough to re-run it. */
  params: Record<string, RunParam>;
  /** One-line human summary. */
  summary: string;
  /** The results table (omit for tools without rows). */
  table?: ResultTable;
  /** Failure reason for an errored run. */
  error?: string | null;
}

/** A finished run ready to record. */
export interface FinishedRun extends RunSnapshot {
  tool: NetworkHistoryTool;
  status: NetworkRunStatus;
  startedAt: string;
  /** Where it ran; defaults to the tool's current "Run on" choice. */
  runLocation?: RunLocation;
}

/** The tool's current "Run on" selection (This computer when unset). */
export function currentRunLocation(tool: NetworkHistoryTool): RunLocation {
  return useRunLocationStore.getState().networkToolLocations[tool] ?? THIS_COMPUTER;
}

/** Build a history record from a finished run (new id, `endedAt` = now). */
export function buildRunRecord(run: FinishedRun, now: Date = new Date()): NetworkToolRun {
  const record: NetworkToolRun = {
    id: crypto.randomUUID(),
    tool: run.tool,
    params: run.params,
    runLocation: run.runLocation ?? currentRunLocation(run.tool),
    startedAt: run.startedAt,
    endedAt: now.toISOString(),
    status: run.status,
    summary: run.summary,
  };
  if (run.error) record.error = run.error;
  if (run.table) {
    record.result = {
      columns: run.table.columns,
      rows: run.table.rows.slice(0, MAX_HISTORY_ROWS),
      totalRows: run.table.rows.length,
    };
  }
  return record;
}

/** Record a finished run to the history (fire-and-forget; never throws). */
export function recordToolRun(run: FinishedRun): Promise<void> {
  return useNetworkToolHistoryStore.getState().record(buildRunRecord(run));
}

/** A recorded run's result table as CSV (header only when it has no rows). */
export function runToCsv(run: NetworkToolRun): string {
  return tableToCsv(run.result ?? { columns: [], rows: [] });
}

/** Recorded runs as pretty-printed JSON. */
export function runsToJson(runs: NetworkToolRun[]): string {
  return JSON.stringify(runs, null, 2) + "\n";
}

/** Map a streaming panel's terminal status onto a recorded status. */
function toRunStatus(status: DiagnosticStatus): NetworkRunStatus | null {
  return status === "completed" || status === "canceled" || status === "error" ? status : null;
}

/**
 * Record a streaming tool's run when its status leaves `running`.
 *
 * The params are captured when the run starts (the fields stay editable while
 * it runs); `snapshot` is read again at the end for the summary and results.
 */
export function useRecordRunOnFinish(
  tool: NetworkHistoryTool,
  status: DiagnosticStatus,
  snapshot: () => RunSnapshot
): void {
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const startRef = useRef<{
    startedAt: string;
    params: Record<string, RunParam>;
    runLocation: RunLocation;
  } | null>(null);

  useEffect(() => {
    if (status === "running") {
      startRef.current ??= {
        startedAt: new Date().toISOString(),
        params: snapshotRef.current().params,
        runLocation: currentRunLocation(tool),
      };
      return;
    }
    const start = startRef.current;
    const finished = toRunStatus(status);
    startRef.current = null;
    if (!start || !finished) return;
    const snap = snapshotRef.current();
    void recordToolRun({ ...snap, ...start, tool, status: finished });
  }, [status, tool]);
}

/**
 * Re-run support: returns a `request` fn that fires `start` on the render
 * *after* the caller has applied a past run's params to its field state, so
 * `start` sees the new values.
 */
export function useRerunAfterUpdate(start: () => unknown): () => void {
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!pending) return;
    setPending(false);
    const result = start();
    if (result instanceof Promise) result.catch(() => {});
  }, [pending, start]);
  return useCallback(() => setPending(true), []);
}

/** Read a string param (empty string when absent). */
export function paramString(run: NetworkToolRun, key: string): string {
  const value = run.params[key];
  return value == null ? "" : String(value);
}

/** Read a numeric param, or `""` (an empty NumberInput) when absent. */
export function paramNumber(run: NetworkToolRun, key: string): number | "" {
  const value = run.params[key];
  return typeof value === "number" ? value : "";
}
