/**
 * Wait for the shell's redraw after a PTY resize before releasing held input (#4958).
 *
 * Applying a resize (TIOCSWINSZ / ConPTY resize) only *notifies* the program:
 * bash's readline handles SIGWINCH lazily and redraws its prompt line, and
 * ConPTY repaints its screen, some time after the resize call has returned.
 * Input written in that window is echoed first and then clobbered by the
 * redraw — the echoed command line vanishes (macOS bash) or the keystrokes are
 * repainted away (Windows ConPTY), seen as a typed `echo` that needs a resend
 * in the system tests (MT-LOCAL-33).
 *
 * The redraw is output, so the session's next output chunk after the resize is
 * the signal that the program has caught up. Input stays held until that chunk
 * arrived (plus a short quiet period for a multi-chunk repaint), bounded by
 * {@link RESIZE_REDRAW_WAIT_MS} for a program that does not redraw at all.
 */

/** Longest wait (ms) for a redraw after a resize before input is released anyway. */
export const RESIZE_REDRAW_WAIT_MS = 250;

/** Extra wait (ms) after the first redraw chunk, for a repaint split over chunks. */
export const RESIZE_REDRAW_QUIET_MS = 30;

/** Per-session output signal that resize holds wait on. */
export interface ShellRedrawWait {
  /** Report a chunk of session output. */
  notifyOutput(): void;
  /**
   * Call `release` once output arrived after this call (then
   * `quietMs` later) or after `maxMs`, whichever comes first. Exactly once.
   */
  releaseAfterRedraw(release: () => void, maxMs?: number, quietMs?: number): void;
  /** Release every pending wait now (session teardown). */
  releaseAll(): void;
}

/** Create the redraw wait for one terminal session. */
export function createShellRedrawWait(): ShellRedrawWait {
  /** Pending waits: each maps to the callback run on the next output chunk. */
  const pending = new Map<() => void, () => void>();

  return {
    notifyOutput() {
      for (const onOutput of [...pending.values()]) onOutput();
    },
    releaseAfterRedraw(release, maxMs = RESIZE_REDRAW_WAIT_MS, quietMs = RESIZE_REDRAW_QUIET_MS) {
      let quiet: ReturnType<typeof setTimeout> | null = null;
      const finish = (): void => {
        if (!pending.has(finish)) return;
        pending.delete(finish);
        clearTimeout(bound);
        if (quiet !== null) clearTimeout(quiet);
        release();
      };
      const bound = setTimeout(finish, maxMs);
      pending.set(finish, () => {
        if (quiet === null) quiet = setTimeout(finish, quietMs);
      });
    },
    releaseAll() {
      for (const finish of [...pending.keys()]) finish();
    },
  };
}
