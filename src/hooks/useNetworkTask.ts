import { useCallback, useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { DiagnosticStatus } from "@/types/network";
import { frontendLog } from "@/utils/frontendLog";

/** Context handed to {@link UseNetworkTaskOptions.subscribe}. */
export interface NetworkTaskContext {
  /**
   * True when an event belongs to the active run. Accepts events while the
   * task id is still null (i.e. before the start command's id has round-tripped
   * back) so a result/error the backend emits immediately isn't dropped — the
   * listeners-before-start race that left panels stuck on "running".
   */
  matchesTask: (taskId: string) => boolean;
  /** Register an unlisten fn so it is torn down when the run ends. */
  register: (unlisten: UnlistenFn) => void;
  /** End the run with a terminal status (and optional error message). */
  finish: (status: "completed" | "error", message?: string) => void;
}

/** Options for {@link useNetworkTask}. */
export interface UseNetworkTaskOptions {
  /** Launch the backend task; resolves to its task id. */
  start: () => Promise<string>;
  /** Cancel a running task by id. */
  cancel: (taskId: string) => Promise<void>;
  /**
   * Register all event listeners for the run. Called BEFORE {@link start} so no
   * early event can be missed. Use `register` for each listener so teardown is
   * automatic, and call `finish` from the complete/error handlers.
   */
  subscribe: (ctx: NetworkTaskContext) => Promise<void>;
  /** Clear per-run result state before a new run starts. */
  onReset?: () => void;
  /** Scope used for {@link frontendLog} messages. */
  logScope: string;
}

/** Lifecycle of a streaming network diagnostic (port scan, traceroute, …). */
export interface UseNetworkTask {
  status: DiagnosticStatus;
  error: string | null;
  /** Start a new run. */
  run: () => Promise<void>;
  /** Cancel the active run (reported as "canceled"). */
  stop: () => Promise<void>;
}

/**
 * Drive a streaming, cancellable backend diagnostic that emits result/complete/
 * error events keyed by a task id.
 *
 * Centralises the lifecycle shared by the network-tools panels: it registers
 * listeners *before* the start command (closing the event race), filters events
 * to the active task, tears listeners down on completion/error/stop, and cancels
 * any in-flight task on unmount. Panels supply the backend calls and their own
 * result-state handling via {@link UseNetworkTaskOptions.subscribe}.
 *
 * Stop is reported as "canceled" immediately and the listeners are removed, so a
 * late complete event can't override it — suitable for tasks whose stop is final
 * (port scan, traceroute). Tasks that need post-cancel data (e.g. ping's final
 * stats) keep their own handler instead.
 */
export function useNetworkTask({
  start,
  cancel,
  subscribe,
  onReset,
  logScope,
}: UseNetworkTaskOptions): UseNetworkTask {
  const [status, setStatus] = useState<DiagnosticStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const taskIdRef = useRef<string | null>(null);
  const unlistenersRef = useRef<UnlistenFn[]>([]);
  // Hold the latest cancel fn for the unmount cleanup without re-running it.
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;

  const teardown = useCallback(() => {
    unlistenersRef.current.forEach((un) => un());
    unlistenersRef.current = [];
    taskIdRef.current = null;
  }, []);

  const run = useCallback(async () => {
    setStatus("running");
    setError(null);
    onReset?.();
    teardown();

    const ctx: NetworkTaskContext = {
      matchesTask: (id) => taskIdRef.current === null || id === taskIdRef.current,
      register: (un) => unlistenersRef.current.push(un),
      finish: (next, message) => {
        if (message != null) setError(message);
        setStatus(next);
        teardown();
      },
    };

    try {
      await subscribe(ctx);
      taskIdRef.current = await start();
    } catch (err) {
      setError(String(err));
      setStatus("error");
      teardown();
      frontendLog(logScope, `Task failed: ${err}`);
    }
  }, [start, subscribe, onReset, teardown, logScope]);

  const stop = useCallback(async () => {
    const id = taskIdRef.current;
    if (!id) return;
    try {
      await cancel(id);
    } catch (err) {
      frontendLog(logScope, `Cancel failed: ${err}`);
    }
    setStatus("canceled");
    teardown();
  }, [cancel, teardown, logScope]);

  // Cancel any in-flight task and drop listeners on unmount.
  useEffect(() => {
    return () => {
      if (taskIdRef.current) void cancelRef.current(taskIdRef.current).catch(() => {});
      unlistenersRef.current.forEach((un) => un());
      unlistenersRef.current = [];
    };
  }, []);

  return { status, error, run, stop };
}
