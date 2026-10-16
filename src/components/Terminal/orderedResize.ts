/**
 * Ordered, latest-wins delivery of PTY resizes (#4841).
 *
 * `resize_terminal` is an async Tauri command, and the backend runs concurrent
 * invokes as independent tasks, so two resizes sent back to back can be applied
 * in the opposite order. A fit that briefly measures a degenerate 2x1 grid and
 * then the real one sends `2x1` then `85x37`; when the backend applies them
 * reversed, the PTY is left at 2x1 while the terminal shows 85x37. The
 * frontend's "only send on change" dedupe then believes the PTY is at 85x37 and
 * never corrects it, so every program in the shell lays out at 2 columns.
 *
 * This sender keeps at most one resize in flight per terminal. A resize
 * requested while one is in flight replaces any queued one, and goes out once
 * the in-flight invoke settles. The last requested size is always the last one
 * the backend applies.
 */

/** A resize request: the session to resize and its new grid. */
interface ResizeRequest {
  sessionId: string;
  cols: number;
  rows: number;
}

/** Sends one resize to the backend; the returned promise settles once it is applied. */
export type ResizeSend = (sessionId: string, cols: number, rows: number) => Promise<unknown>;

/** Requests a PTY resize; delivery is ordered and coalesced to the latest size. */
export type OrderedResize = (sessionId: string, cols: number, rows: number) => void;

/**
 * Create an {@link OrderedResize} for one terminal.
 *
 * `onError` receives a failed send's error; the next queued resize still goes
 * out, so one failure never stalls later resizes.
 */
export function createOrderedResize(
  send: ResizeSend,
  onError: (err: unknown, request: ResizeRequest) => void
): OrderedResize {
  let inFlight = false;
  let queued: ResizeRequest | null = null;

  const pump = async (): Promise<void> => {
    inFlight = true;
    while (queued) {
      const request = queued;
      queued = null;
      try {
        await send(request.sessionId, request.cols, request.rows);
      } catch (err) {
        onError(err, request);
      }
    }
    inFlight = false;
  };

  return (sessionId, cols, rows) => {
    queued = { sessionId, cols, rows };
    if (!inFlight) void pump();
  };
}
