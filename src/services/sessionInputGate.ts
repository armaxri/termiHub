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
 * is lifted. Nothing is ever dropped. Every hold is bounded
 * ({@link INPUT_HOLD_MAX_MS} by default, {@link RESIZE_INPUT_HOLD_MAX_MS} behind
 * a resize in flight), so a resize that never settles, or a frame that never
 * comes (an occluded window), delays input instead of swallowing it.
 *
 * A paste reserves a slot in the same order (#5026): its clipboard read is
 * async, so keys typed right after the paste shortcut would otherwise reach the
 * shell before the pasted text. Input sent after the reservation waits behind
 * the slot until the paste fills it (or gives it up), so the paste lands in
 * keystroke order, as in a real terminal.
 */

import { frontendLog } from "@/utils/frontendLog";

/** Upper bound (ms) on any single hold; after it the hold lifts on its own. */
export const INPUT_HOLD_MAX_MS = 1000;

/**
 * Upper bound (ms) on a hold behind a PTY resize that is still on its way to the
 * backend (#5025). Tauri runs invokes concurrently, so input released while
 * `resize_terminal` is in flight can be applied before the resize, and the
 * shell echoes it at the old width. On a loaded macOS runner the IPC stalled
 * for 1.3 s, past {@link INPUT_HOLD_MAX_MS}, and the typed line overtook the
 * resize. So this hold waits for the resize itself; the bound only keeps input
 * from waiting forever on a resize that never settles.
 */
export const RESIZE_INPUT_HOLD_MAX_MS = 10_000;

/**
 * One place in a session's input order. A ready entry carries its send; a slot
 * entry ({@link reserveSessionInputSlot}) has none until it is filled, and
 * input queued after it waits for it.
 */
interface Entry {
  run: (() => void) | null;
}

interface Gate {
  holds: number;
  queue: Entry[];
}

const gates = new Map<string, Gate>();

/** When input was last handed to each session's send (ms epoch). */
const lastSentAt = new Map<string, number>();

/**
 * Each session's latest send, settled or not. A send starts only once the one
 * before it has settled (#4993): every send is its own async IPC call, and the
 * backend runs those concurrently, so two keystrokes in flight at once could
 * reach the PTY in either order (`ceho` for `echo` on a loaded Windows host).
 */
const sendTails = new Map<string, Promise<unknown>>();

/**
 * The slot being filled right now, if any: input sent for its session while its
 * fill runs takes the slot's place in the order instead of queueing at the end.
 */
let filling: { sessionId: string; gate: Gate; slot: Entry } | null = null;

/** When input was last sent to `sessionId` (ms epoch), if ever. */
export function lastSessionInputAt(sessionId: string): number | undefined {
  return lastSentAt.get(sessionId);
}

function gateFor(sessionId: string): Gate {
  let gate = gates.get(sessionId);
  if (!gate) {
    gate = { holds: 0, queue: [] };
    gates.set(sessionId, gate);
  }
  return gate;
}

/**
 * Send what is ready at the head of `gate`'s queue, stopping at a hold or at an
 * unfilled slot. Once nothing holds it and nothing waits in it, the gate is
 * dropped, so later input goes straight out.
 */
function drain(sessionId: string, gate: Gate): void {
  while (gate.holds === 0 && gate.queue.length > 0) {
    const run = gate.queue[0].run;
    if (!run) return;
    gate.queue.shift();
    run();
  }
  if (gate.holds === 0 && gate.queue.length === 0 && gates.get(sessionId) === gate) {
    gates.delete(sessionId);
  }
}

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
  const held = gateFor(sessionId);
  held.holds += 1;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    held.holds -= 1;
    drain(sessionId, held);
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

/** A reserved place in a session's input order (see {@link reserveSessionInputSlot}). */
export interface SessionInputSlot {
  /**
   * Run `send` now. Input it sends for the slot's session (synchronously, as
   * `sendInput` does before its first await) goes out in the slot's place, ahead
   * of everything sent after the reservation. Once the slot is settled
   * (cancelled or lifted), `send` simply runs, and its input queues normally.
   */
  fill<T>(send: () => Promise<T>): Promise<T>;
  /** Give the slot up; input queued behind it flows on (idempotent). */
  cancel(): void;
  /** Restart the slot's bound with `maxMs` (e.g. while a confirmation is shown). */
  extend(maxMs: number): void;
}

/**
 * Reserve `sessionId`'s next place in its input order (#5026).
 *
 * Input sent after the reservation waits until the slot is filled or cancelled,
 * so a paste whose clipboard read is still pending keeps the place of the
 * shortcut that started it, the way a real terminal inserts a paste in
 * keystroke order. Input sent before it is not delayed. A slot not settled
 * within `maxMs` lifts itself, so a read that never resolves delays typing
 * briefly instead of swallowing it.
 */
export function reserveSessionInputSlot(
  sessionId: string,
  reason: string,
  maxMs: number = INPUT_HOLD_MAX_MS
): SessionInputSlot {
  const gate = gateFor(sessionId);
  const slot: Entry = { run: null };
  gate.queue.push(slot);
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const settle = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    const at = gate.queue.indexOf(slot);
    if (at >= 0) gate.queue.splice(at, 1);
    drain(sessionId, gate);
  };
  const arm = (ms: number): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (settled) return;
      frontendLog(
        "terminal",
        `input slot (${reason}) lifted after ${ms}ms without fill session=${sessionId}`
      );
      settle();
    }, ms);
  };
  arm(maxMs);

  return {
    fill<T>(send: () => Promise<T>): Promise<T> {
      if (settled) return send();
      const outer = filling;
      filling = { sessionId, gate, slot };
      let result: Promise<T>;
      try {
        result = send();
      } finally {
        filling = outer;
        settle();
      }
      return result;
    },
    cancel: settle,
    extend(ms: number): void {
      if (!settled) arm(ms);
    },
  };
}

/** Whether `sessionId`'s input is currently held (by a hold or a pending slot). */
export function isSessionInputHeld(sessionId: string): boolean {
  return gates.has(sessionId);
}

/**
 * Run `send` for `sessionId` now, or — while the session is held — once every
 * hold is released, after all input queued before it. Either way it starts
 * only after the session's previous send has settled, so input reaches the
 * backend strictly in order.
 */
export function whenSessionInputOpen<T>(sessionId: string, send: () => Promise<T>): Promise<T> {
  const sendNow = (): Promise<T> => {
    const run = (): Promise<T> => {
      lastSentAt.set(sessionId, Date.now());
      return send();
    };
    const previous = sendTails.get(sessionId);
    const sent = previous ? previous.then(run) : run();
    // The tail only marks "settled"; a failure still reaches this send's caller.
    const tail = Promise.allSettled([sent]);
    sendTails.set(sessionId, tail);
    void tail.then(() => {
      if (sendTails.get(sessionId) === tail) sendTails.delete(sessionId);
    });
    return sent;
  };
  const fillingSlot = filling && filling.sessionId === sessionId ? filling : null;
  const gate = fillingSlot ? fillingSlot.gate : gates.get(sessionId);
  if (!gate) return sendNow();
  return new Promise<T>((resolve, reject) => {
    const entry: Entry = {
      run: () => {
        sendNow().then(resolve, reject);
      },
    };
    // A slot's fill goes in the slot's place (ahead of it, so several sends of
    // one fill keep their order); anything else queues at the end.
    const at = fillingSlot ? gate.queue.indexOf(fillingSlot.slot) : -1;
    if (at >= 0) gate.queue.splice(at, 0, entry);
    else gate.queue.push(entry);
  });
}

/** Drop every gate (tests only). Queued input is discarded, not sent. */
export function resetSessionInputGatesForTests(): void {
  gates.clear();
  lastSentAt.clear();
  sendTails.clear();
}
