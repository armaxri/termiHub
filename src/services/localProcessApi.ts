/**
 * Frontend bridge to the guarded local-process backend command (#1857).
 *
 * The `run-local-process` workflow step spawns a program on the user's own
 * machine, so every call here is gated in the store by the opt-in setting and a
 * per-program authorization (see `appStore.runWorkflow`). This module only wraps
 * the Tauri command and its streamed-output event — it performs no gating itself.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Tauri event name carrying one streamed line of local-process output. */
const LOCAL_PROCESS_OUTPUT_EVENT = "workflow-local-process-output";

/** One streamed line of a local process's output. */
export interface LocalProcessOutputChunk {
  /** The run id the line belongs to. */
  runId: string;
  /** Which stream produced it. */
  stream: "stdout" | "stderr";
  /** The line of text (no trailing newline). */
  line: string;
}

/** The terminal outcome of a spawned local process, mirroring the Rust struct. */
export interface LocalProcessOutcome {
  /** Exit code, or `null` when the process was killed (cancelled/timed out). */
  exitCode: number | null;
  /** `true` when killed for exceeding the timeout. */
  timedOut: boolean;
  /** `true` when killed because the run was cancelled. */
  cancelled: boolean;
}

/** Arguments for {@link invokeRunLocalProcess}. */
export interface RunLocalProcessArgs {
  /** Unique id for this run, used to route output events and target a cancel. */
  runId: string;
  /** The program to spawn (direct argv — no shell). */
  program: string;
  /** Discrete argument vector (never concatenated into a command line). */
  args: string[];
  /** Optional timeout in ms; the backend applies a default and a hard cap. */
  timeoutMs?: number;
}

/**
 * Spawn a guarded local process and resolve its outcome once it finishes. The
 * backend re-checks the master opt-in and rejects if it is disabled, so a
 * disabled setting surfaces as a rejected promise here.
 */
export async function invokeRunLocalProcess(
  args: RunLocalProcessArgs
): Promise<LocalProcessOutcome> {
  return await invoke<LocalProcessOutcome>("run_local_process", {
    runId: args.runId,
    program: args.program,
    args: args.args,
    timeoutMs: args.timeoutMs ?? null,
  });
}

/** Request cancellation of an in-flight local process by its run id. */
export async function cancelLocalProcess(runId: string): Promise<boolean> {
  return await invoke<boolean>("cancel_local_process", { runId });
}

/**
 * Subscribe to streamed output for a specific run. The handler is invoked once
 * per line, for stdout and stderr both. Returns an unlisten function to call when
 * the run ends.
 */
export async function subscribeLocalProcessOutput(
  runId: string,
  onChunk: (chunk: LocalProcessOutputChunk) => void
): Promise<UnlistenFn> {
  return await listen<LocalProcessOutputChunk>(LOCAL_PROCESS_OUTPUT_EVENT, (event) => {
    if (event.payload.runId === runId) onChunk(event.payload);
  });
}
