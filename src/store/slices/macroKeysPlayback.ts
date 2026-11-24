/**
 * Macro playback through the automation runner (#5818, slice 4). A macro is a
 * macro-shaped automation; playing it runs that automation with
 * `runAutomation` (slice 3), whose `type-keys` step types the chunks through the
 * `send` seam bound here. The Macros view keeps its own progress, toasts and
 * history on top of this.
 */
import { runAutomation, runAutomationOnTargets } from "@/services/automationRunner";
import type {
  MacroInjector,
  MacroPlaybackHandle,
  MacroPlaybackStatus,
  MacroTimingMode,
} from "@/services/macroPlayback";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationStep } from "@/types/generated/AutomationStep";
import type { TypingSpeed } from "@/types/generated/TypingSpeed";
import type { Macro } from "@/types/macro";

import type { AppState } from "../appStore";
import { automationForRun } from "./automationStoreState";
import { macroToAutomation } from "./automationViews";

/** A running macro playback (the same shape as a macro-playback handle). */
export type MacroKeysPlayback = MacroPlaybackHandle;

/** A per-run timing override from the play dialog; absent keeps the saved timing. */
export interface MacroTimingOverride {
  timingMode?: MacroTimingMode;
  fixedDelayMs?: number;
}

const SPEED_FOR_MODE: Record<MacroTimingMode, TypingSpeed> = {
  "real-time": "recorded",
  fixed: "fixed",
  instant: "instant",
};

const MODE_FOR_SPEED: Record<TypingSpeed, MacroTimingMode> = {
  recorded: "real-time",
  fixed: "fixed",
  instant: "instant",
};

/** Apply a timing override to every `type-keys` step. A **pure** helper. */
function withTiming(steps: AutomationStep[], override: MacroTimingOverride): AutomationStep[] {
  const mode = override.timingMode;
  if (!mode) return steps;
  return steps.map((step) => {
    if (step.kind !== "type-keys") return step;
    const next: AutomationStep = { ...step, timing: SPEED_FOR_MODE[mode] };
    if (mode === "fixed" && override.fixedDelayMs !== undefined) {
      next.fixedDelayMs = override.fixedDelayMs;
    }
    return next;
  });
}

/** The automation a macro view plays. */
function automationOf(state: AppState, macro: Macro): Automation {
  return automationForRun(state, macro.id) ?? macroToAutomation(macro);
}

/**
 * The timing a playback of `macro` uses: the override, else the saved timing
 * of its first `type-keys` step (macros migrated from `macros.json` type as
 * recorded, which is the old "real-time" default).
 */
export function effectiveTimingMode(
  state: AppState,
  macro: Macro,
  override: MacroTimingOverride
): MacroTimingMode {
  if (override.timingMode) return override.timingMode;
  const first = automationOf(state, macro).steps.find((s) => s.kind === "type-keys");
  return MODE_FOR_SPEED[(first?.kind === "type-keys" && first.timing) || "recorded"];
}

/**
 * Play `macro` by running its automation with `inject` as the `send` seam.
 * `onProgress` fires after each chunk reaches the target, with the chunks
 * typed so far and the macro's chunk count; `stepsPlayed` counts the same.
 */
export function playAutomationKeys(
  state: AppState,
  macro: Macro,
  inject: MacroInjector,
  override: MacroTimingOverride,
  hooks: { onProgress?: (played: number, total: number) => void } = {}
): MacroKeysPlayback {
  const base = automationOf(state, macro);
  const automation: Automation = { ...base, steps: withTiming(base.steps, override) };
  const total = macro.steps.length;
  let played = 0;
  const handle = runAutomation(automation, {
    send: async (data) => {
      const ok = await inject(data);
      if (ok) {
        played += 1;
        hooks.onProgress?.(played, total);
      }
      return ok;
    },
    resolveAutomation: (id) => automationForRun(state, id),
  });
  return {
    done: handle.done.then((result) => ({
      status: result.status === "failed" ? "error" : result.status,
      stepsPlayed: played,
    })),
    cancel: handle.cancel,
  };
}

/** How one target of a multi-terminal playback ended. */
export interface MacroTargetOutcome {
  /** The target tab. */
  tabId: string;
  /** `undefined` when the target never started (every target was stopped first). */
  status: MacroPlaybackStatus | undefined;
  /** Chunks typed into this target. */
  stepsPlayed: number;
  /** When this target's own run started (a queued one starts later). */
  startedAt?: Date;
  /** When this target's own run ended. */
  endedAt?: Date;
}

/** Hooks of {@link playAutomationKeysOnTargets}. */
export interface MacroTargetsHooks {
  /** After a chunk reaches `tabId`, with the chunks typed there so far. */
  onProgress?: (tabId: string, played: number, total: number) => void;
  /** When `tabId`'s own run ends, however it ended. */
  onTargetEnd?: (tabId: string) => void;
}

/** A running playback of one macro on several terminals. */
export interface MacroTargetsPlayback {
  /** Resolves once every started target's run has ended, in target order. */
  done: Promise<MacroTargetOutcome[]>;
  /** Stop one target's run, also one still queued; the others keep going. */
  cancel: (tabId: string) => void;
  /** Stop every target and start no queued one. */
  cancelAll: () => void;
}

/**
 * Play `macro` on each of `targets` as an independent run (#5818, slice 5),
 * through `runAutomationOnTargets`: at most 8 at once (`parallel`, the
 * default), or one after another. This replaces the lock-step fan-out: a
 * slow or dropped target no longer holds the others back, and one that stops
 * accepting input (`inject` resolves `false`) ends only its own run.
 */
export function playAutomationKeysOnTargets(
  state: AppState,
  macro: Macro,
  targets: readonly string[],
  inject: (tabId: string, data: string) => Promise<boolean> | boolean,
  options: { override?: MacroTimingOverride; parallel?: boolean },
  hooks: MacroTargetsHooks = {}
): MacroTargetsPlayback {
  const base = automationOf(state, macro);
  const automation: Automation = {
    ...base,
    steps: withTiming(base.steps, options.override ?? {}),
  };
  const total = macro.steps.length;
  const played = targets.map(() => 0);
  // Targets stopped before their run started; they must never type.
  const stopped = new Set<number>();
  const started = new Set<number>();
  const startedAt: Date[] = [];
  const endedAt: Date[] = [];
  const handle = runAutomationOnTargets(
    automation,
    targets,
    (tabId, index) => ({
      send: async (data) => {
        if (stopped.has(index)) return false;
        const ok = await inject(tabId, data);
        if (ok) {
          played[index] += 1;
          hooks.onProgress?.(tabId, played[index], total);
        }
        return ok;
      },
      resolveAutomation: (id) => automationForRun(state, id),
    }),
    {
      parallel: options.parallel,
      onTargetStart: (index) => {
        started.add(index);
        startedAt[index] = new Date();
        if (stopped.has(index)) handle.cancel(index);
      },
      onTargetEnd: (index) => {
        endedAt[index] = new Date();
        hooks.onTargetEnd?.(targets[index]);
      },
    }
  );
  return {
    done: handle.done.then((results) =>
      results.map((result, index) => ({
        tabId: targets[index],
        status:
          result === undefined
            ? undefined
            : stopped.has(index)
              ? "cancelled"
              : result.status === "failed"
                ? "error"
                : result.status,
        stepsPlayed: played[index],
        startedAt: startedAt[index],
        endedAt: endedAt[index],
      }))
    ),
    cancel: (tabId) => {
      const index = targets.indexOf(tabId);
      if (index < 0) return;
      if (started.has(index)) {
        handle.cancel(index);
      } else if (!stopped.has(index)) {
        stopped.add(index);
        hooks.onTargetEnd?.(tabId);
      }
    },
    cancelAll: handle.cancelAll,
  };
}
