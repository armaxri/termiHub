import type { UniqueIdentifier } from "@dnd-kit/core";
import { errorMessage } from "@/utils/errorMessage";
import { frontendDurableInfo } from "@/utils/frontendLog";

/**
 * Durable diagnostics for file-browser drag-to-move (#4110).
 *
 * The Windows (WebView2) nightly drag test never lands its drop and leaves no
 * trace: plain frontend logs below WARN never reach `termihub.log`, the only
 * frontend evidence a CI failure artifact keeps. These helpers log one line per
 * gesture *phase* (pending, start, over-change, end, cancel, abort, drag-out),
 * never per pointer move, through {@link frontendDurableInfo} so the next run
 * says whether the sensor activated, what `over` was at release, and what (if
 * anything) cancelled the drag.
 */

/** Log target for every drag diagnostic line. */
export const FILE_DRAG_LOG_TARGET = "file_drag";

/**
 * Write one durable drag diagnostic line. The message is built lazily inside a
 * guard: a diagnostic must never throw out of a dnd-kit handler and break the
 * very drop it is describing.
 */
export function logFileDrag(build: () => string): void {
  let message: string;
  try {
    message = build();
  } catch (err) {
    message = `(could not describe drag event: ${errorMessage(err)})`;
  }
  frontendDurableInfo(FILE_DRAG_LOG_TARGET, message);
}

/** Render a dnd-kit id (or its absence) for a log line. */
export function describeDndId(id: UniqueIdentifier | null | undefined): string {
  return id == null ? "none" : String(id);
}

/**
 * The fields of a pointer/mouse event that decide whether dnd-kit's
 * PointerSensor activates and where it thinks the pointer is — `pointerType`,
 * `button`/`buttons`, `isPrimary`, `isTrusted` and the client coordinates.
 */
export function describePointerEvent(event: Event | null | undefined): string {
  if (!event) return "event=none";
  const e = event as Partial<PointerEvent>;
  const parts = [`type=${event.type}`];
  if (e.pointerType !== undefined) parts.push(`pointerType=${e.pointerType || "''"}`);
  if (e.button !== undefined) parts.push(`button=${e.button}`);
  if (e.buttons !== undefined) parts.push(`buttons=${e.buttons}`);
  if (e.isPrimary !== undefined) parts.push(`isPrimary=${e.isPrimary}`);
  parts.push(`trusted=${event.isTrusted}`);
  if (typeof e.clientX === "number" && typeof e.clientY === "number") {
    parts.push(`at=(${Math.round(e.clientX)},${Math.round(e.clientY)})`);
  }
  return parts.join(" ");
}

/** A window/document event that makes dnd-kit's PointerSensor cancel a drag. */
export interface CancelSignal {
  /** What fired: `resize`, `visibilitychange`, `pointercancel`, `escape` or `drag-out`. */
  kind: string;
  /** Extra context (e.g. the visibility state, the new viewport size). */
  detail: string;
  /** `performance.now()`-style timestamp of the signal. */
  at: number;
}

/**
 * How recent a cancel signal must be to be blamed for a cancel/abort. dnd-kit
 * cancels synchronously inside the signal's own listener, so the matching
 * signal is a few milliseconds old at most; a wider window only guards against
 * scheduling jitter without blaming a stale, unrelated resize.
 */
export const CANCEL_SIGNAL_WINDOW_MS = 1000;

/**
 * How long after a drag-ending event the provider waits for dnd-kit's
 * `onDragEnd`/`onDragCancel` before declaring the drag lost. dnd-kit calls them
 * synchronously from the ending event's own listener when it has committed the
 * drag; a missing call is therefore already final after one task, and this only
 * leaves room for scheduling jitter.
 */
export const LOST_DRAG_CHECK_MS = 300;

/**
 * Records the window/document events that end dnd-kit's PointerSensor drag — a
 * release (`pointerup`) and the cancels (window `resize` and `visibilitychange`,
 * `pointercancel`, Escape) — plus the provider's own drag-out hand-off, so a
 * cancel, a pre-activation abort, or a drag dnd-kit dropped without any callback
 * can be logged with its cause instead of "nothing happened".
 */
export class CancelSignalRecorder {
  private last: CancelSignal | null = null;
  private detachFns: Array<() => void> = [];

  constructor(private readonly now: () => number = () => performance.now()) {}

  private onSignal: ((kind: string) => void) | null = null;

  /** Note a drag-ending signal (also used directly for the drag-out hand-off). */
  note(kind: string, detail = ""): void {
    this.last = { kind, detail, at: this.now() };
    this.onSignal?.(kind);
  }

  /**
   * The cause of a cancel/abort happening now: the latest signal within
   * {@link CANCEL_SIGNAL_WINDOW_MS}, consumed so it is never blamed twice.
   */
  takeReason(): string {
    const signal = this.last;
    this.last = null;
    if (!signal || this.now() - signal.at > CANCEL_SIGNAL_WINDOW_MS) {
      return "unknown (no pointerup/resize/visibilitychange/pointercancel/Escape seen)";
    }
    return signal.detail ? `${signal.kind} (${signal.detail})` : signal.kind;
  }

  /**
   * Start listening on `win` (and its document); `onSignal` is told about every
   * drag-ending signal as it happens. Idempotent.
   */
  attach(win: Window, onSignal?: (kind: string) => void): void {
    if (this.detachFns.length > 0) return;
    this.onSignal = onSignal ?? null;
    const doc = win.document;
    const listen = (target: EventTarget, type: string, fn: (e: Event) => void) => {
      target.addEventListener(type, fn, true);
      this.detachFns.push(() => target.removeEventListener(type, fn, true));
    };
    listen(win, "resize", () =>
      this.note("resize", `viewport=${win.innerWidth}x${win.innerHeight}`)
    );
    // dnd-kit listens for `visibilitychange` on the window; the browser fires it
    // on the document (it bubbles to the window), the drag-out hand-off fires a
    // synthetic one straight on the window. Either way the window sees it.
    listen(win, "visibilitychange", () => {
      // The drag-out hand-off notes itself just before its synthetic event; keep
      // that more specific cause rather than overwriting it.
      if (this.last?.kind === "drag-out" && this.now() - this.last.at < CANCEL_SIGNAL_WINDOW_MS) {
        return;
      }
      this.note("visibilitychange", `visibilityState=${doc.visibilityState}`);
    });
    listen(doc, "pointerup", () => this.note("pointerup"));
    listen(doc, "pointercancel", () => this.note("pointercancel"));
    listen(doc, "keydown", (e) => {
      if ((e as KeyboardEvent).key === "Escape") this.note("escape");
    });
  }

  /** Stop listening. */
  detach(): void {
    for (const fn of this.detachFns) fn();
    this.detachFns = [];
    this.last = null;
    this.onSignal = null;
  }
}
