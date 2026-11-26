/**
 * What an automation types into a terminal is marked there (#6021, R-068): a
 * triggered or scheduled run is recognisable in the scrollback, and the user's
 * own typing is never marked.
 *
 * Both engines that type (macro playback and workflow runs) send through the one
 * injector seam; {@link markAutomationInput} wraps it for a run, and tells the
 * terminal of the tab each time the run starts a line there. The terminal draws
 * the mark ({@link decorateAutomationTyping}); nothing is written into its output,
 * so copy, paste, the recorder and the session log see only what was typed.
 */
import type { AutomationRunOrigin } from "@/types/generated/AutomationRunOrigin";
import { tf, t, type MessageId } from "@/i18n/catalog";

/** Which run typed a line, and when it started that line. */
export interface AutomationTyping {
  automationId: string;
  name: string;
  origin: AutomationRunOrigin;
  /** When the line was started, in ms. */
  at: number;
}

type Listener = (typing: AutomationTyping) => void;

const listeners = new Map<string, Set<Listener>>();

/** Hear the lines automations start in `tabId`; returns the unsubscribe. */
export function subscribeAutomationTyping(tabId: string, listener: Listener): () => void {
  const set = listeners.get(tabId) ?? new Set<Listener>();
  listeners.set(tabId, set);
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0 && listeners.get(tabId) === set) listeners.delete(tabId);
  };
}

/** Forget every listener (tests). */
export function resetAutomationTypingForTest(): void {
  listeners.clear();
}

/** Whether `data` ends the line it types: Enter, or a newline. */
const endsLine = (data: string): boolean => /[\r\n]$/.test(data);

/**
 * The injector of one run, which marks each line the run starts in a terminal:
 * its first input there, and the first after an Enter. The mark goes out before
 * the input, so it lands on the line the input echoes on.
 */
export function markAutomationInput<R>(
  inject: (tabId: string, data: string) => R,
  run: Omit<AutomationTyping, "at">,
  now: () => number = Date.now
): (tabId: string, data: string) => R {
  const midLine = new Set<string>();
  return (tabId, data) => {
    if (!midLine.has(tabId) && data.length > 0) {
      const typing: AutomationTyping = { ...run, at: now() };
      for (const listener of [...(listeners.get(tabId) ?? [])]) listener(typing);
    }
    if (endsLine(data)) midLine.delete(tabId);
    else if (data.length > 0) midLine.add(tabId);
    return inject(tabId, data);
  };
}

const HOW: Record<AutomationRunOrigin, MessageId> = {
  manual: "automation.mark.how.manual",
  palette: "automation.mark.how.palette",
  hotkey: "automation.mark.how.hotkey",
  "on-connect": "automation.mark.how.onConnect",
  "on-disconnect": "automation.mark.how.onDisconnect",
  "on-output-match": "automation.mark.how.onOutputMatch",
  scheduled: "automation.mark.how.scheduled",
  "run-by-automation": "automation.mark.how.byAutomation",
};

/** `HH:MM:SS`, the clock the run history and the Services use. */
function clockOf(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** What the mark says: which automation typed the line, what started it, and when. */
export function automationTypingLabel(typing: AutomationTyping): string {
  return tf("automation.mark.title", {
    name: typing.name,
    how: t(HOW[typing.origin]),
    time: clockOf(typing.at),
  });
}
