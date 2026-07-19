/**
 * Macro playback scheduler (#1675).
 *
 * Drives a stored macro's recorded {@link MacroStep}s back into a terminal by
 * calling an injector callback for each step, honouring a timing mode and a
 * cancel affordance. The scheduler is intentionally decoupled from the store and
 * from the terminal registry: it takes a plain `inject(data) => Promise<boolean>`
 * callback, so it can be unit-tested with a mock and reused wherever an injector
 * is available.
 *
 * The single injection seam is {@link TerminalRegistry.sendInputToTerminal},
 * which routes through the existing `send_input` choke point (line-ending
 * normalization included). The terminal registry registers that method here via
 * {@link registerTerminalInputInjector} so the store's `playMacro` action can
 * reach it without holding a React ref.
 */
import type { MacroStep } from "@/types/macro";

/** How inter-step delays are derived during playback. */
export type MacroTimingMode = "real-time" | "fixed" | "instant";

/** Default per-step delay (ms) used by the `fixed` timing mode. */
export const DEFAULT_FIXED_DELAY_MS = 40;

/**
 * Upper bound (ms) applied to any single computed delay. Recorded `real-time`
 * delays can be arbitrarily large (the user paused mid-recording); clamp them so
 * playback never appears to hang for minutes on a single step.
 */
export const MAX_STEP_DELAY_MS = 5000;

/** Injects one chunk of input into a terminal; resolves `true` when delivered. */
export type MacroInjector = (data: string) => Promise<boolean> | boolean;

/** Options controlling how a macro's steps are scheduled. */
export interface MacroPlaybackOptions {
  /** Timing mode governing the delay before each step. */
  timingMode: MacroTimingMode;
  /** Per-step delay (ms) for the `fixed` mode. Defaults to {@link DEFAULT_FIXED_DELAY_MS}. */
  fixedDelayMs?: number;
  /** Clamp for any single computed delay. Defaults to {@link MAX_STEP_DELAY_MS}. */
  maxDelayMs?: number;
}

/** Terminal outcome of a playback run. */
export type MacroPlaybackStatus = "completed" | "cancelled" | "error";

/** Result of a finished playback run. */
export interface MacroPlaybackResult {
  status: MacroPlaybackStatus;
  /** Number of steps successfully injected before the run ended. */
  stepsPlayed: number;
}

/** Optional lifecycle hooks fired as playback advances. */
export interface MacroPlaybackHooks {
  /** Fired after each step is injected, with the 1-based count and total. */
  onProgress?: (played: number, total: number) => void;
}

/** A running playback that can be awaited or cancelled. */
export interface MacroPlaybackHandle {
  /** Resolves when playback finishes (completed, cancelled, or errored). */
  done: Promise<MacroPlaybackResult>;
  /** Request cancellation; the run stops before the next step is injected. */
  cancel: () => void;
}

/**
 * Compute the delay (ms) to wait before playing `step` at position `index`.
 *
 * The very first step always plays immediately so playback starts promptly
 * regardless of mode. Thereafter:
 * - `instant` — no delay.
 * - `fixed` — a constant `fixedDelayMs` per step, ignoring recorded timing.
 * - `real-time` — the step's recorded `delayMs`, clamped to `[0, maxDelayMs]`.
 */
export function computeStepDelay(
  step: MacroStep,
  index: number,
  options: MacroPlaybackOptions
): number {
  if (index <= 0) return 0;
  const {
    timingMode,
    fixedDelayMs = DEFAULT_FIXED_DELAY_MS,
    maxDelayMs = MAX_STEP_DELAY_MS,
  } = options;
  switch (timingMode) {
    case "instant":
      return 0;
    case "fixed":
      return Math.max(0, Math.min(fixedDelayMs, maxDelayMs));
    case "real-time":
    default:
      return Math.max(0, Math.min(step.delayMs, maxDelayMs));
  }
}

/**
 * Schedule and run a macro's steps through `inject`, honouring `options` and
 * supporting cancellation. Returns a {@link MacroPlaybackHandle} whose `done`
 * promise resolves once the run finishes.
 *
 * If `inject` resolves `false` for any step (e.g. the target session vanished),
 * the run stops with status `error`. Cancellation is checked both before each
 * delay and after it, so a cancel during a long real-time wait stops promptly.
 */
export function runMacroPlayback(
  steps: MacroStep[],
  inject: MacroInjector,
  options: MacroPlaybackOptions,
  hooks?: MacroPlaybackHooks
): MacroPlaybackHandle {
  let cancelled = false;
  let activeTimer: ReturnType<typeof setTimeout> | null = null;
  let wake: (() => void) | null = null;

  const cancel = (): void => {
    cancelled = true;
    if (activeTimer !== null) {
      clearTimeout(activeTimer);
      activeTimer = null;
    }
    if (wake) {
      const resolve = wake;
      wake = null;
      resolve();
    }
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (ms <= 0 || cancelled) {
        resolve();
        return;
      }
      wake = resolve;
      activeTimer = setTimeout(() => {
        activeTimer = null;
        wake = null;
        resolve();
      }, ms);
    });

  const done = (async (): Promise<MacroPlaybackResult> => {
    for (let i = 0; i < steps.length; i++) {
      if (cancelled) return { status: "cancelled", stepsPlayed: i };
      await sleep(computeStepDelay(steps[i], i, options));
      if (cancelled) return { status: "cancelled", stepsPlayed: i };
      const delivered = await inject(steps[i].data);
      if (!delivered) return { status: "error", stepsPlayed: i };
      hooks?.onProgress?.(i + 1, steps.length);
    }
    return { status: "completed", stepsPlayed: steps.length };
  })();

  return { done, cancel };
}

/**
 * Injects input into a specific terminal tab; resolves `true` when a session was
 * found and the input sent. Mirrors {@link TerminalRegistry.sendInputToTerminal}.
 */
export type TerminalInputInjector = (tabId: string, data: string) => Promise<boolean>;

let terminalInputInjector: TerminalInputInjector | null = null;

/**
 * Register (or clear, with `null`) the terminal-input injector used by macro
 * playback. The terminal registry provider calls this on mount so the store can
 * inject through the single `send_input` seam without a React ref.
 */
export function registerTerminalInputInjector(fn: TerminalInputInjector | null): void {
  terminalInputInjector = fn;
}

/** The currently-registered terminal-input injector, or `null` when none. */
export function getTerminalInputInjector(): TerminalInputInjector | null {
  return terminalInputInjector;
}
