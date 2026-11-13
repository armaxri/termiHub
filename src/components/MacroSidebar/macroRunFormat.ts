import type { MacroRun, MacroRunOrigin } from "@/types/macro";

/**
 * Sentence-case label for what launched a playback (R-081, #5680), matching
 * the workflow history's trigger labels ("Manual", "Scheduled").
 */
export function macroRunOriginLabel(origin: MacroRunOrigin): string {
  switch (origin) {
    case "manual":
      return "Manual";
    case "palette":
      return "Palette";
    case "workflow-step":
      return "Workflow step";
    case "scheduled":
      return "Scheduled";
  }
}

/** Where a playback went: the single target's label, or "N terminals". */
export function macroRunTargetsText(run: MacroRun): string {
  const labels = run.targetLabels ?? [];
  if (run.targetCount === 1 && labels.length === 1) return labels[0];
  return `${run.targetCount} terminal${run.targetCount === 1 ? "" : "s"}`;
}

/**
 * The most recent playback of each macro, keyed by macro id, for the macro
 * row's "Last run" line (#5680). Picks by `endedAt`, so the result does not
 * depend on the order the history arrives in.
 */
export function latestMacroRuns(runs: MacroRun[]): Map<string, MacroRun> {
  const latest = new Map<string, MacroRun>();
  for (const run of runs) {
    const seen = latest.get(run.macroId);
    if (!seen || Date.parse(run.endedAt) > Date.parse(seen.endedAt)) {
      latest.set(run.macroId, run);
    }
  }
  return latest;
}
