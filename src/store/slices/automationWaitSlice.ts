/**
 * The waits of running automations (#6025): a "Wait for you" step stops its run
 * until the user presses Continue, so that a password a recording left out is
 * typed by the user and by nobody else. Nothing but Continue goes on. Stop, the
 * end of the terminal and {@link WAIT_FOR_USER_LIMIT_MS} end the run instead.
 */
import { StateCreator } from "zustand";

import { isPasswordPrompt, promptOfTerminal } from "@/services/passwordPrompt";
import {
  WAIT_FOR_USER_LIMIT_MS,
  type WaitForUserResult,
  type WorkflowStepSignal,
} from "@/services/workflowRunner";

import type { AppState } from "../appStore";
import { getActiveTab } from "../layoutHelpers";
import { isTabEvicted } from "../sessionBridge";
import { resolveConnectedTargets } from "./workflowFanout";

/** A run that waits for the user. */
export interface AutomationWait {
  /** The run that waits. */
  runId: string;
  tabId: string;
  tabTitle: string;
  automationName: string;
  /** What the user is asked to do; absent for the general wording. */
  message?: string;
  /** When the run stops if nobody continued, in epoch milliseconds. */
  until: number;
  /**
   * Continue was pressed while the terminal still asked for a password. The
   * next press goes on.
   */
  stillAsking: boolean;
  /** Continue was pressed, and the output that had arrived is being taken in (#6070). */
  checking?: boolean;
  /**
   * Continue was pressed, and it could not be told in time whether the terminal asks
   * for a password. The next press goes on if it still cannot.
   */
  unchecked?: boolean;
  /** Continue was pressed while another window or computer controls the terminal. */
  elsewhere?: boolean;
  /** Its terminal showed a password prompt since it waits. */
  prompted?: boolean;
  /** That prompt is gone: the password was typed (C-006). */
  answered?: boolean;
}

/** What {@link AutomationWaitSlice.waitForUser} needs to know. */
export type AutomationWaitRequest = Omit<AutomationWait, "until" | "stillAsking"> & {
  /** The session the run types into. Another one in the same tab is not it. */
  sessionId: string;
};

export interface AutomationWaitSlice {
  /** The runs that wait for the user, oldest first. */
  automationWaits: AutomationWait[];
  /** Wait for the user. Resolves once, when the wait ends. */
  waitForUser: (
    request: AutomationWaitRequest,
    signal?: WorkflowStepSignal
  ) => Promise<WaitForUserResult>;
  /**
   * Go on with a waiting run. Only from its own terminal: from elsewhere the call
   * shows it. While the terminal shows a password prompt, the first call only says so;
   * output that has arrived counts before it shows (#6070). A prompt that arrives after
   * the call cannot be seen.
   */
  continueAutomationWait: (runId: string) => void;
  /** Look at the terminals that wait: is their password prompt answered? */
  recheckWaitingPrompts: () => void;
  /** End the waits whose terminal was closed, moved away or disconnected. */
  followWaitingTerminals: () => void;
}

/** Asks for a terminal to be brought to the front. `WaitingRunBar` does it. */
export const SHOW_WAITING_TERMINAL_EVENT = "termihub:show-waiting-terminal";

function show(tabId: string): void {
  window.dispatchEvent(new CustomEvent(SHOW_WAITING_TERMINAL_EVENT, { detail: { tabId } }));
}

/** How long Continue waits for the output that had arrived to be taken in (#6070). */
export const PROMPT_CHECK_LIMIT_MS = 1000;
/** When that shows: normally it takes a frame. */
export const PROMPT_CHECK_SHOWS_MS = 150;

/** What ends each wait, by run. Not serializable, so not in the store. */
const pending = new Map<string, { sessionId: string; end: (result: WaitForUserResult) => void }>();

/** Whether the prompt that held Continue back is still the one that shows, by run. */
const heldBackBy = new Map<string, () => boolean>();

/** Runs whose Continue is being decided. */
const deciding = new Set<string>();

/**
 * Read the prompt of terminal `tabId` with the output that has arrived, or give
 * `null` when that cannot be told within {@link PROMPT_CHECK_LIMIT_MS}. `slow` is
 * called when it takes long enough to notice.
 */
function readPrompt(tabId: string, slow: () => void, then: (before: string | null) => void): void {
  const terminal = promptOfTerminal(tabId);
  if (!terminal) {
    then(null);
    return;
  }
  let done = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const finish = (before: string | null) => {
    if (done) return;
    done = true;
    timers.forEach(clearTimeout);
    then(before);
  };
  terminal.read(finish);
  if (done) return;
  timers.push(setTimeout(slow, PROMPT_CHECK_SHOWS_MS));
  timers.push(setTimeout(() => finish(null), PROMPT_CHECK_LIMIT_MS));
}

export const createAutomationWaitSlice: StateCreator<AppState, [], [], AutomationWaitSlice> = (
  set,
  get
) => {
  const waitOf = (runId: string) => get().automationWaits.find((w) => w.runId === runId);
  const change = (runId: string, patch: Partial<AutomationWait>) =>
    set({
      automationWaits: get().automationWaits.map((w) =>
        w.runId === runId ? { ...w, ...patch } : w
      ),
    });

  /** The wait Continue may go on with now, after the checks that need no reading. */
  const continuable = (runId: string): AutomationWait | null => {
    const wait = waitOf(runId);
    if (!wait) return null;
    if (Date.now() >= wait.until) {
      // The timer sleeps while the computer does: too late is too late.
      pending.get(runId)?.end("timed-out");
      return null;
    }
    // Nobody continues into a terminal they do not see (B-001): the first press only
    // shows it, whatever it came from.
    const visible = getActiveTab(get())?.id === wait.tabId;
    show(wait.tabId);
    if (!visible) return null;
    const elsewhere =
      isTabEvicted(wait.tabId) || get().isSessionWindowEvicted(pending.get(runId)?.sessionId);
    if (!elsewhere) return wait;
    // What it shows here is old, and nothing typed here reaches it.
    change(runId, { elsewhere, stillAsking: false, unchecked: false });
    return null;
  };

  return {
    automationWaits: [],

    waitForUser: ({ sessionId, ...request }, signal) => {
      if (signal?.isCancelled()) return Promise.resolve("cancelled");
      const { runId, tabId } = request;
      return new Promise<WaitForUserResult>((resolve) => {
        const end = (result: WaitForUserResult): void => {
          if (pending.get(runId)?.end !== end) return;
          pending.delete(runId);
          heldBackBy.delete(runId);
          clearTimeout(timer);
          set({ automationWaits: get().automationWaits.filter((w) => w.runId !== runId) });
          resolve(result);
        };
        const timer = setTimeout(() => end("timed-out"), WAIT_FOR_USER_LIMIT_MS);
        pending.set(runId, { sessionId, end });
        void signal?.whenCancelled?.then(() => end("cancelled"));
        set({
          automationWaits: [
            ...get().automationWaits,
            { ...request, until: Date.now() + WAIT_FOR_USER_LIMIT_MS, stillAsking: false },
          ],
        });
        // The bar above the terminals says it, wherever the user is (C-009). One who is
        // in that terminal types at once; the run may have been started elsewhere.
        if (getActiveTab(get())?.id === tabId) show(tabId);
      });
    },

    continueAutomationWait: (runId) => {
      const wait = continuable(runId);
      // A press while one is being decided is the same press.
      if (!wait || deciding.has(runId)) return;
      deciding.add(runId);
      const decide = (before: string | null) => {
        deciding.delete(runId);
        if (waitOf(runId)?.checking) change(runId, { checking: false });
        // It may have ended, or the user may have gone elsewhere meanwhile.
        const now = continuable(runId);
        if (!now) return;
        if (before === null) {
          if (!now.unchecked) {
            change(runId, {
              unchecked: true,
              stillAsking: false,
              answered: false,
              elsewhere: false,
            });
            return;
          }
        } else if (isPasswordPrompt(before)) {
          // Insisting counts for the prompt it was said of, not for the next one.
          if (!now.stillAsking || heldBackBy.get(runId)?.() !== true) {
            const pin = promptOfTerminal(now.tabId)?.pin();
            if (pin) heldBackBy.set(runId, pin);
            change(runId, { stillAsking: true, unchecked: false, elsewhere: false });
            return;
          }
        }
        pending.get(runId)?.end("continued");
      };
      readPrompt(wait.tabId, () => change(runId, { checking: true }), decide);
    },

    recheckWaitingPrompts: () => {
      for (const { runId, tabId } of get().automationWaits) {
        // What cannot be told now is told the next time.
        promptOfTerminal(tabId)?.read((before) => {
          const w = waitOf(runId);
          if (!w) return;
          const asking = isPasswordPrompt(before);
          const prompted = w.prompted === true || asking || w.stillAsking;
          const next = {
            prompted,
            answered: prompted && !asking,
            stillAsking: w.stillAsking && asking,
            unchecked: w.unchecked === true && asking,
            elsewhere:
              w.elsewhere === true &&
              (isTabEvicted(tabId) || get().isSessionWindowEvicted(pending.get(runId)?.sessionId)),
          };
          const same = (Object.keys(next) as (keyof typeof next)[]).every(
            (key) => (w[key] ?? false) === next[key]
          );
          if (!same) change(runId, next);
        });
      }
    },

    followWaitingTerminals: () => {
      for (const { runId, tabId } of get().automationWaits) {
        const wait = pending.get(runId);
        const [target] = resolveConnectedTargets(get(), [tabId]).targets;
        if (wait && target?.sessionId !== wait.sessionId) wait.end("gone");
      }
    },
  };
};
