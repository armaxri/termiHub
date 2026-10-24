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
 *
 * The same race runs the other way round: input already sent, a resize right
 * behind it. The program then redraws for the resize while it is still
 * echoing the input. So a resize also waits (bounded) until the session has
 * answered the most recent input with output — its echo.
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
   * A promise resolving once the session produced output after input sent at
   * `inputAt` (ms epoch), or `maxMs` after it — or `null` (nothing to wait
   * for) when there is no such input, it was answered, or it is older.
   */
  waitForInputEcho(inputAt: number | undefined, maxMs?: number): Promise<void> | null;
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
  let lastOutputAt = 0;

  /** Run `onDone` on the next output chunk or after `ms`, exactly once. */
  const nextOutputOr = (ms: number, onOutput: (finish: () => void) => void, onDone: () => void) => {
    const finish = (): void => {
      if (!pending.has(finish)) return;
      pending.delete(finish);
      clearTimeout(bound);
      onDone();
    };
    const bound = setTimeout(finish, ms);
    pending.set(finish, () => onOutput(finish));
  };

  return {
    notifyOutput() {
      lastOutputAt = Date.now();
      for (const onOutput of [...pending.values()]) onOutput();
    },
    waitForInputEcho(inputAt, maxMs = RESIZE_REDRAW_WAIT_MS) {
      if (inputAt === undefined || lastOutputAt > inputAt) return null;
      const remaining = inputAt + maxMs - Date.now();
      if (remaining <= 0) return null;
      return new Promise<void>((resolve) => nextOutputOr(remaining, (finish) => finish(), resolve));
    },
    releaseAfterRedraw(release, maxMs = RESIZE_REDRAW_WAIT_MS, quietMs = RESIZE_REDRAW_QUIET_MS) {
      let quiet: ReturnType<typeof setTimeout> | null = null;
      nextOutputOr(
        maxMs,
        (finish) => {
          quiet ??= setTimeout(finish, quietMs);
        },
        () => {
          if (quiet !== null) clearTimeout(quiet);
          release();
        }
      );
    },
    releaseAll() {
      for (const finish of [...pending.keys()]) finish();
    },
  };
}
