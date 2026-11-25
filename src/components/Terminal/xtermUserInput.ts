/**
 * Typed adapter over xterm.js's PRIVATE "this came from the user" event (#5818,
 * slice 8). `onData` also carries what the terminal itself sends: focus reports
 * and replies to queries (cursor position, device attributes, colors). A
 * recording must not replay those as typed keys. xterm fires `onUserInput` right
 * before the `onData` of real input (keys, IME, mouse); that event is not part of
 * the public API, so it is reached here and pinned by `xtermUserInput.test.ts`.
 */
import type { Terminal as XTerm } from "@xterm/xterm";

interface XtermWithUserInput {
  _core?: {
    coreService?: { onUserInput?: (listener: () => void) => { dispose(): void } };
  };
}

/** Tells, once per `onData`, whether the data came from the user. */
export interface UserInputTracker {
  /** Whether xterm tells at all; otherwise `take` is always true. */
  known: boolean;
  take: () => boolean;
  dispose: () => void;
}

/** Track `xterm`'s user input. Without the private event, everything counts as the user's. */
export function trackUserInput(xterm: XTerm): UserInputTracker {
  const onUserInput = (xterm as unknown as XtermWithUserInput)._core?.coreService?.onUserInput;
  if (typeof onUserInput !== "function") {
    return { known: false, take: () => true, dispose: () => undefined };
  }
  let pending = false;
  const subscription = onUserInput(() => {
    pending = true;
  });
  return {
    known: true,
    take: () => {
      const user = pending;
      pending = false;
      return user;
    },
    dispose: () => subscription.dispose(),
  };
}
