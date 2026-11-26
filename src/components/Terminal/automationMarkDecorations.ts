import type { IDisposable, Terminal } from "@xterm/xterm";
import { automationTypingLabel, type AutomationTyping } from "@/services/automationTypingMarks";

/** The tint under a line an automation typed (styled in Terminal.css). */
export const AUTOMATION_MARK_CLASS = "terminal-automation-mark";
/** The badge at the end of that line, which says who typed it. */
export const AUTOMATION_BADGE_CLASS = "terminal-automation-badge";

/** The part of xterm the mark needs, so tests can pass a fake. */
export type AutomationMarkTerminal = Pick<
  Terminal,
  "registerMarker" | "registerDecoration" | "cols"
>;

/**
 * Mark the line at the cursor as typed by an automation (#6021, R-068).
 *
 * - A tint under the row, on the layer below the text: the text stays as it is
 *   for reading, selecting, copying and searching.
 * - A badge at the row's right end, on top, whose tooltip says which automation
 *   typed it, what started it and when; a click opens its runs in History.
 *
 * Both hang on one xterm marker, so they move with the line when it scrolls and
 * reflows, and go when the scrollback drops it. Returns what removes them, or
 * `undefined` when xterm cannot place a marker (no buffer yet).
 */
export function decorateAutomationTyping(
  term: AutomationMarkTerminal,
  typing: AutomationTyping,
  openHistory: (automationId: string) => void
): IDisposable | undefined {
  const marker = term.registerMarker(0);
  if (!marker) return undefined;
  const label = automationTypingLabel(typing);
  const row = term.registerDecoration({ marker, width: term.cols, layer: "bottom" });
  row?.onRender((el) => el.classList.add(AUTOMATION_MARK_CLASS));
  const badge = term.registerDecoration({ marker, layer: "top" });
  badge?.onRender((el) => {
    if (el.dataset.automationMark === "1") return;
    el.dataset.automationMark = "1";
    el.classList.add(AUTOMATION_BADGE_CLASS);
    el.title = label;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", label);
    el.addEventListener("click", () => openHistory(typing.automationId));
  });
  return {
    dispose: () => {
      row?.dispose();
      badge?.dispose();
      marker.dispose();
    },
  };
}
