/**
 * Frontend bridge to the guarded local-process backend commands (#1857).
 *
 * The backend decides what may start, for every run (#5994): it holds the rule
 * and the allowlist check. {@link checkLocalProcess} asks it beforehand, so the
 * user can be asked about a program that is not on the list; the decision itself
 * is made again when the program starts. This module performs no gating.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { LocalProcessCheck } from "@/types/generated/LocalProcessCheck";
import type { LocalProcessOutcome } from "@/types/generated/LocalProcessOutcome";
import type { LocalProcessOutputChunk } from "@/types/generated/LocalProcessOutputChunk";

// Generated from the Rust `LocalProcessOutcome` / `LocalProcessOutputEvent`
// (src-tauri/src/commands/local_process.rs) via ts-rs (#3088).
export type { LocalProcessCheck, LocalProcessOutcome, LocalProcessOutputChunk };

/** Tauri event name carrying one streamed line of local-process output. */
const LOCAL_PROCESS_OUTPUT_EVENT = "workflow-local-process-output";

/** Arguments for {@link invokeRunLocalProcess}. */
export interface RunLocalProcessArgs {
  /** Unique id for this run, used to route output events and target a cancel. */
  runId: string;
  /** The program to spawn (direct argv — no shell). */
  program: string;
  /** Discrete argument vector (never concatenated into a command line). */
  args: string[];
  /**
   * The ids of the automations behind the command, the one the run started with
   * first (#6019). The backend traces the command through them.
   */
  automationChain: readonly string[];
  /**
   * The file the user approved for this run ({@link LocalProcessCheck} `ask`
   * named it). The backend starts an unlisted program only as this file.
   */
  approvedPath?: string;
  /** Optional timeout in ms; the backend applies a default and a hard cap. */
  timeoutMs?: number;
}

/**
 * Spawn a guarded local process and resolve its outcome once it finishes. The
 * backend decides from the persisted settings whether the program may start and
 * rejects with the reason when it may not.
 */
export async function invokeRunLocalProcess(
  args: RunLocalProcessArgs
): Promise<LocalProcessOutcome> {
  return await invoke<LocalProcessOutcome>("run_local_process", {
    runId: args.runId,
    program: args.program,
    args: args.args,
    automationChain: args.automationChain,
    timeoutMs: args.timeoutMs ?? null,
    approvedPath: args.approvedPath ?? null,
  });
}

/** Ask the backend whether a command may start now, or the user has to be asked. */
export async function checkLocalProcess(
  program: string,
  args: readonly string[],
  automationChain: readonly string[]
): Promise<LocalProcessCheck> {
  return await invoke<LocalProcessCheck>("check_local_process", { program, args, automationChain });
}

/**
 * The user confirmed a command of an imported automation, as the file at `path`
 * (#6019): the backend does not ask about this very command again.
 */
export async function confirmLocalProcess(
  program: string,
  args: readonly string[],
  automationChain: readonly string[],
  path: string
): Promise<void> {
  await invoke("confirm_local_process", { program, args, automationChain, path });
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
