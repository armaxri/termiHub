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
  openHistory: (automationId: string) => void,
  /** Rows from the cursor to the line to mark (negative: above it). */
  offset = 0
): IDisposable | undefined {
  const marker = term.registerMarker(offset);
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
    el.dataset.testid = "automation-mark-badge";
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

/** Shorter typed text matches too much to place a mark by (one key, `ls`). */
export const MIN_TYPED_MATCH = 3;
/** How much of the typed line is matched: a long one may wrap in the terminal. */
const TYPED_MATCH_CHARS = 40;

/**
 * The index of the first of `rows` (the terminal's rows from where the cursor
 * was when the run typed, on) that shows `text`, the line it typed; `null`
 * while none does (#6183, automations-2). The cursor can sit on output when a
 * run types (a wait-for-output matched the output before the shell printed its
 * prompt), so the mark waits for the echo instead of taking the cursor's row.
 */
export function typedRowIndex(rows: readonly string[], text: string): number | null {
  const needle = text.trim().slice(0, TYPED_MATCH_CHARS);
  if (needle.length === 0) return null;
  const index = rows.findIndex((row) => row.includes(needle));
  return index === -1 ? null : index;
}

/** How long a mark waits for its line to echo before it gives up (ms). */
export const ECHO_WAIT_MS = 3000;

/** The part of xterm placing a mark needs: its buffer and its parsed writes. */
export type AutomationMarkHost = AutomationMarkTerminal &
  Pick<Terminal, "onWriteParsed"> & {
    buffer: { active: Pick<Terminal["buffer"]["active"], "baseY" | "cursorY" | "getLine"> };
  };

/**
 * Mark the line an automation typed (#6183, automations-2): the row its text
 * echoes on, found from where the cursor was when it typed, at once or as the
 * echo is written. A short key (one letter, `ls`) is marked at the cursor as
 * before. Without an echo within {@link ECHO_WAIT_MS} nothing is marked: no
 * mark is better than one on output it did not type. Returns what removes the
 * mark, or stops waiting for it.
 */
export function placeAutomationMark(
  term: AutomationMarkHost,
  typing: AutomationTyping,
  openHistory: (automationId: string) => void
): IDisposable {
  let mark: IDisposable | undefined;
  const text = typing.text?.trim() ?? "";
  if (text.length < MIN_TYPED_MATCH) {
    mark = decorateAutomationTyping(term, typing, openHistory);
    return { dispose: () => mark?.dispose() };
  }
  const cursorRow = () => term.buffer.active.baseY + term.buffer.active.cursorY;
  const start = cursorRow();
  const tryPlace = (): boolean => {
    const end = cursorRow();
    const rows: string[] = [];
    for (let row = start; row <= end; row++) {
      rows.push(term.buffer.active.getLine(row)?.translateToString(true) ?? "");
    }
    const index = typedRowIndex(rows, text);
    if (index === null) return false;
    mark = decorateAutomationTyping(term, typing, openHistory, start + index - end);
    return true;
  };
  if (tryPlace()) return { dispose: () => mark?.dispose() };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const writes = term.onWriteParsed(() => {
    if (tryPlace()) stop();
  });
  const stop = () => {
    writes.dispose();
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  timer = setTimeout(stop, ECHO_WAIT_MS);
  return {
    dispose: () => {
      stop();
      mark?.dispose();
    },
  };
}
