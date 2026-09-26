/**
 * Multi-target ("broadcast") macro playback helpers (PROD-042, #3443).
 *
 * A macro can be replayed into several terminals at once. Each recorded step is
 * delivered to every still-connected target before the scheduler moves on, so
 * the targets advance in lock-step and share one timing/cancel affordance. A
 * target that disconnects (or is taken over by another window) mid-run is
 * dropped — it never receives a later step — and the run keeps going for the
 * rest; the final summary reports exactly how many terminals got the whole macro.
 */
import type {
  MacroInjector,
  MacroPlaybackStatus,
  TerminalInputInjector,
} from "@/services/macroPlayback";

/** A fan-out injector plus accessors for which targets are still receiving. */
export interface MacroFanoutInjector {
  /** Inject one step into every live target; `false` once no target is left. */
  inject: MacroInjector;
  /** Targets that are still receiving input (request order). */
  live: () => string[];
  /** Targets dropped mid-run because they stopped being connected. */
  dropped: () => string[];
}

/**
 * Build a {@link MacroInjector} that fans each step out to `targets`.
 *
 * Before every step `stillConnected` re-filters the live set (so a target that
 * disconnected or was evicted between steps is dropped *before* it could receive
 * a partial command), and a target whose injection fails is dropped as well.
 * Resolves `false` — ending the run with `error` — only once every target is gone.
 */
export function createMacroFanoutInjector(
  targets: readonly string[],
  injector: TerminalInputInjector | null,
  stillConnected: (tabIds: string[]) => string[]
): MacroFanoutInjector {
  let live = [...targets];
  const dropped: string[] = [];
  const drop = (id: string) => {
    live = live.filter((t) => t !== id);
    dropped.push(id);
  };

  const inject: MacroInjector = async (data) => {
    if (!injector) return false;
    const connectedNow = new Set(stillConnected(live));
    for (const id of [...live]) if (!connectedNow.has(id)) drop(id);
    const ids = [...live];
    const results = await Promise.all(
      ids.map((id) => injector(id, data).catch((): boolean => false))
    );
    ids.forEach((id, i) => {
      if (!results[i]) drop(id);
    });
    return live.length > 0;
  };

  return { inject, live: () => [...live], dropped: () => [...dropped] };
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
      message: `Playback of "${macroName}" cancelled`,
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
