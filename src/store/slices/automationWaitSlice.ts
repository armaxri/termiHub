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
   * shows it. While the terminal shows a password prompt, the first call only says so.
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

/** What ends each wait, by run. Not serializable, so not in the store. */
const pending = new Map<string, { sessionId: string; end: (result: WaitForUserResult) => void }>();

export const createAutomationWaitSlice: StateCreator<AppState, [], [], AutomationWaitSlice> = (
  set,
  get
) => ({
  automationWaits: [],

  waitForUser: ({ sessionId, ...request }, signal) => {
    if (signal?.isCancelled()) return Promise.resolve("cancelled");
    const { runId, tabId } = request;
    return new Promise<WaitForUserResult>((resolve) => {
      const end = (result: WaitForUserResult): void => {
        if (pending.get(runId)?.end !== end) return;
        pending.delete(runId);
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
    const wait = get().automationWaits.find((w) => w.runId === runId);
    if (!wait) return;
    if (Date.now() >= wait.until) {
      // The timer sleeps while the computer does: too late is too late.
      pending.get(runId)?.end("timed-out");
      return;
    }
    // Nobody continues into a terminal they do not see (B-001): the first press only
    // shows it, whatever it came from.
    if (getActiveTab(get())?.id !== wait.tabId) {
      show(wait.tabId);
      return;
    }
    if (!wait.stillAsking && isPasswordPrompt(promptOfTerminal(wait.tabId))) {
      set({
        automationWaits: get().automationWaits.map((w) =>
          w.runId === runId ? { ...w, stillAsking: true } : w
        ),
      });
      show(wait.tabId);
      return;
    }
    show(wait.tabId);
    pending.get(runId)?.end("continued");
  },

  recheckWaitingPrompts: () => {
    const next = get().automationWaits.map((w) => {
      const asking = isPasswordPrompt(promptOfTerminal(w.tabId));
      const prompted = w.prompted === true || asking || w.stillAsking;
      const answered = prompted && !asking;
      const stillAsking = w.stillAsking && asking;
      const same =
        prompted === (w.prompted === true) &&
        answered === (w.answered === true) &&
        stillAsking === w.stillAsking;
      return same ? w : { ...w, prompted, answered, stillAsking };
    });
    if (next.some((w, i) => w !== get().automationWaits[i])) set({ automationWaits: next });
  },

  followWaitingTerminals: () => {
    for (const { runId, tabId } of get().automationWaits) {
      const wait = pending.get(runId);
      const [target] = resolveConnectedTargets(get(), [tabId]).targets;
      if (wait && target?.sessionId !== wait.sessionId) wait.end("gone");
    }
  },
});
