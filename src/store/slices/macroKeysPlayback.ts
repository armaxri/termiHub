/**
 * Macro playback through the automation runner (#5818, slice 4). A macro is a
 * macro-shaped automation; playing it runs that automation with
 * `runAutomation` (slice 3), whose `type-keys` step types the chunks through the
 * `send` seam bound here. The Macros view keeps its own progress, toasts and
 * history on top of this.
 */
import { runAutomation } from "@/services/automationRunner";
import type { MacroInjector, MacroPlaybackHandle, MacroTimingMode } from "@/services/macroPlayback";
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
