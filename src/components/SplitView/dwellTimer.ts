/**
 * Dwell-to-switch (tab-groups concept, #6201): while a tab is dragged, holding
 * the pointer over another group's chip for {@link GROUP_DWELL_MS} switches to
 * that group, so the tab can be dropped into a split of its layout.
 */

/** How long the pointer rests on a chip before its group is shown. */
export const GROUP_DWELL_MS = 500;

/** A restartable timer keyed by the target under the pointer. */
export interface DwellTimer {
  /** The target under the pointer now (`null`: none). Restarts on a new target. */
  hover(target: string | null): void;
  /** Drop a pending dwell (the drag ended or was cancelled). */
  cancel(): void;
}

/**
 * Call `onDwell(target)` once the pointer has stayed over one target for
 * `delayMs`. Moving within the same target keeps the timer; a new target or
 * none restarts or stops it. It fires once per stay.
 */
export function createDwellTimer(delayMs: number, onDwell: (target: string) => void): DwellTimer {
  let current: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    hover(target) {
      if (target === current) return;
      stop();
      current = target;
      if (target === null) return;
      timer = setTimeout(() => {
        timer = null;
        onDwell(target);
      }, delayMs);
    },
    cancel() {
      stop();
      current = null;
    },
  };
}
