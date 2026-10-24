/**
 * Per-session input gate: holds terminal input behind a pending PTY resize (#4942).
 *
 * A terminal adopts a new grid locally the moment it is fitted (xterm resizes
 * synchronously), but the PTY learns the new size only once the async
 * `resize_terminal` invoke is applied. Input sent in that window reaches the
 * shell while it still believes the old width, so the shell echoes the typed
 * line laid out for the old grid onto the new one: readline wraps a long line
 * at the old column count, and on the wider grid the wrapped tail overwrites
 * the start of the line. The typed text is garbled on screen (the system tests
 * saw it as a command that "never rendered", #4942).
 *
 * The gate fixes the order instead of the timing: while a session is held (a
 * resize is in flight, or a just-shown terminal has not run its show-time fit
 * yet), input for it is queued, and released in arrival order once every hold
 * is lifted. Nothing is ever dropped. Every hold is bounded by
 * {@link INPUT_HOLD_MAX_MS}, so a resize that never settles, or a frame that
 * never comes (an occluded window), delays input briefly instead of swallowing
 * it.
 */

import { frontendLog } from "@/utils/frontendLog";

/** Upper bound (ms) on any single hold; after it the hold lifts on its own. */
export const INPUT_HOLD_MAX_MS = 1000;

interface Gate {
  holds: number;
  queue: Array<() => void>;
}

const gates = new Map<string, Gate>();

/**
 * Hold `sessionId`'s input until the returned release is called (idempotent).
 *
 * Holds nest: input flows again once every hold on the session is released.
 * A hold that is not released within `maxMs` releases itself.
 */
export function holdSessionInput(
  sessionId: string,
  reason: string,
  maxMs: number = INPUT_HOLD_MAX_MS
): () => void {
  let gate = gates.get(sessionId);
  if (!gate) {
    gate = { holds: 0, queue: [] };
    gates.set(sessionId, gate);
  }
  const held = gate;
  held.holds += 1;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    held.holds -= 1;
    if (held.holds > 0) return;
    // Detach the gate before draining: a hold taken while draining starts a new
    // gate, so input sent after it queues behind it, while everything queued
    // here goes out now, in order.
    if (gates.get(sessionId) === held) gates.delete(sessionId);
    for (const send of held.queue.splice(0)) send();
  };
  const timer = setTimeout(() => {
    if (released) return;
    frontendLog(
      "terminal",
      `input hold (${reason}) lifted after ${maxMs}ms without release session=${sessionId}`
    );
    release();
  }, maxMs);
  return release;
}

/** Whether `sessionId`'s input is currently held. */
export function isSessionInputHeld(sessionId: string): boolean {
  return gates.has(sessionId);
}

/**
 * Run `send` for `sessionId` now, or — while the session is held — once every
 * hold is released, after all input queued before it.
 */
export function whenSessionInputOpen<T>(sessionId: string, send: () => Promise<T>): Promise<T> {
  const gate = gates.get(sessionId);
  if (!gate) return send();
  return new Promise<T>((resolve, reject) => {
    gate.queue.push(() => {
      send().then(resolve, reject);
    });
  });
}

/** Drop every gate (tests only). Queued input is discarded, not sent. */
export function resetSessionInputGatesForTests(): void {
  gates.clear();
}
