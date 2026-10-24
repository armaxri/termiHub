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
 *
 * While a resize is queued or in flight, the terminal already shows the new grid
 * but the PTY does not have it yet. `holdInput` (the session input gate) holds
 * the session's input for exactly that window, so a keystroke typed after a fit
 * reaches the shell after the size it was typed at (#4942).
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

/** Holds a session's input until the returned release is called. */
export type HoldInput = (sessionId: string) => () => void;

/**
 * Create an {@link OrderedResize} for one terminal.
 *
 * `onError` receives a failed send's error; the next queued resize still goes
 * out, so one failure never stalls later resizes. `holdInput`, when given, is
 * taken synchronously when a resize is requested and released once the last
 * queued resize has settled (applied or failed).
 */
export function createOrderedResize(
  send: ResizeSend,
  onError: (err: unknown, request: ResizeRequest) => void,
  holdInput?: HoldInput
): OrderedResize {
  let inFlight = false;
  let queued: ResizeRequest | null = null;
  // One input hold per session with a resize queued or in flight.
  const holds = new Map<string, () => void>();

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
    for (const release of holds.values()) release();
    holds.clear();
  };

  return (sessionId, cols, rows) => {
    queued = { sessionId, cols, rows };
    if (holdInput && !holds.has(sessionId)) holds.set(sessionId, holdInput(sessionId));
    if (!inFlight) void pump();
  };
}
