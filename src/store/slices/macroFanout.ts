/**
 * Multi-terminal macro playback helpers (PROD-042, #3443; #5818 slice 5).
 *
 * A macro played on several terminals runs as independent per-target runs
 * (`playAutomationKeysOnTargets`, at most 8 at once). Each target types the
 * whole macro on its own; one that disconnects or stops accepting input ends
 * only its own run, and the others keep going. Before every chunk the target
 * is re-checked, so a tab that dropped or was taken over is never typed into.
 * These helpers bind the per-target input seam and summarise the outcomes.
 */
import type { MacroPlaybackStatus, TerminalInputInjector } from "@/services/macroPlayback";
import { withLoggedFallback } from "@/utils/loggedFallback";

import type { MacroTargetOutcome } from "./macroKeysPlayback";

/**
 * The per-target input seam of a multi-terminal playback: a chunk reaches
 * `tabId` only while `stillConnected` keeps it, and a rejected injection
 * counts as "stopped accepting input" (the target's run then ends with an
 * error). Never throws.
 */
export function createTargetInjector(
  injector: TerminalInputInjector | null,
  stillConnected: (tabId: string) => boolean
): (tabId: string, data: string) => Promise<boolean> {
  return async (tabId, data) => {
    if (!injector || !stillConnected(tabId)) return false;
    return withLoggedFallback(injector(tabId, data), false, "macro", `inject into target ${tabId}`);
  };
}

/** The counts of a finished multi-terminal playback, for its summary. */
export interface MacroTargetsTally {
  /** The playback's overall status (see {@link tallyMacroTargets}). */
  status: MacroPlaybackStatus;
  /** Targets that typed the whole macro. */
  delivered: number;
  /** Targets that stopped accepting input mid-run. */
  dropped: number;
  /** The most chunks any target typed. */
  stepsPlayed: number;
}

/**
 * Fold per-target outcomes into one playback status: `error` when no target
 * finished and none was stopped (every one dropped), `cancelled` when any was
 * stopped or never started, else `completed`. A **pure** helper.
 */
export function tallyMacroTargets(outcomes: readonly MacroTargetOutcome[]): MacroTargetsTally {
  const count = (s: MacroTargetOutcome["status"]) => outcomes.filter((o) => o.status === s).length;
  const delivered = count("completed");
  const dropped = count("error");
  const stopped = count("cancelled") + count(undefined);
  const status: MacroPlaybackStatus =
    stopped > 0 ? "cancelled" : delivered === 0 && dropped > 0 ? "error" : "completed";
  return {
    status,
    delivered,
    dropped,
    stepsPlayed: Math.max(0, ...outcomes.map((o) => o.stepsPlayed)),
  };
}

/** Inputs to {@link describeMacroFanoutOutcome}. */
export interface MacroFanoutOutcome {
  /** How the scheduler run ended. */
  status: MacroPlaybackStatus;
  /** Number of terminals the user asked to play into. */
  requested: number;
  /** Terminals still receiving at the end (got every played step). */
  delivered: number;
  /** Terminals dropped mid-run (disconnected / taken over). */
  dropped: number;
  /** Terminals skipped up front because they were not connected. */
  skipped: number;
  /** Steps played before the run ended. */
  stepsPlayed: number;
  /** Steps in the macro. */
  totalSteps: number;
}

/** The summary toast for a finished multi-target run. */
export interface MacroFanoutSummary {
  /** `success` only when every requested terminal got the whole macro. */
  kind: "success" | "info" | "error";
  message: string;
  description?: string;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Summarise a multi-target run. Anything short of "every requested terminal got
 * every step" is reported as an error toast (which persists until dismissed), so
 * a partially-applied fleet change is never mistaken for a clean run.
 */
export function describeMacroFanoutOutcome(
  macroName: string,
  o: MacroFanoutOutcome
): MacroFanoutSummary {
  const problems: string[] = [];
  if (o.skipped > 0) problems.push(`${o.skipped} skipped (not connected)`);
  if (o.dropped > 0) problems.push(`${o.dropped} stopped early (disconnected mid-playback)`);
  const detail = problems.length > 0 ? problems.join(" · ") : undefined;

  if (o.status === "cancelled") {
    return {
      kind: "info",
      message: `Playback of "${macroName}" canceled`,
      description: [
        `Stopped after ${o.stepsPlayed} of ${o.totalSteps} steps on ${plural(o.delivered, "terminal")}`,
        detail,
      ]
        .filter(Boolean)
        .join(" · "),
    };
  }
  if (o.status === "error") {
    return {
      kind: "error",
      message: `Could not finish "${macroName}" — no target terminal is still connected`,
      description: detail,
    };
  }
  if (problems.length === 0 && o.delivered === o.requested) {
    return {
      kind: "success",
      message: `Played macro "${macroName}" on ${plural(o.delivered, "terminal")}`,
    };
  }
  return {
    kind: "error",
    message: `Played macro "${macroName}" on ${o.delivered} of ${plural(o.requested, "terminal")}`,
    description: detail,
  };
}
