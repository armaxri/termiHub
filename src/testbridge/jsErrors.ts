/**
 * The test bridge's JavaScript error buffer (#5364).
 *
 * Records every `unhandledrejection`, uncaught `error` and `console.error` the
 * app under test produces, so the system-test harness can fail (or annotate) a
 * test that made the real app throw. Read through the `getJsErrors` bridge verb
 * with a since-cursor, so the harness diffs "errors added during this test".
 *
 * This module lives under `src/testbridge/` and is imported only by the lazily
 * loaded `TestBridge` chunk, which `TerminalView` loads behind the build-time
 * `VITE_TEST_BRIDGE === "1"` constant. A production bundle therefore carries
 * none of it, and the capture is installed only when test mode is on.
 */
import type { JsErrorRecord, JsErrorsResult } from "./protocol";

/** Most records kept; older ones are dropped and counted in `dropped`. */
export const JS_ERROR_BUFFER_LIMIT = 500;
/** Longest message kept, in characters. */
export const JS_ERROR_MESSAGE_LIMIT = 2000;
/** Stack frames kept per record ("a short stack"). */
export const JS_ERROR_STACK_LINES = 8;

/** The parts of `window` the capture listens on. */
export type JsErrorTarget = Pick<Window, "addEventListener" | "removeEventListener">;
/** The part of `console` the capture wraps. */
export type JsErrorConsole = Pick<Console, "error">;

/** One message + optional stack, as rendered from an arbitrary thrown value. */
interface Described {
  message: string;
  stack?: string;
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Keep the first {@link JS_ERROR_STACK_LINES} frames of a stack trace. */
export function shortStack(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  const lines = stack.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) return undefined;
  return lines.slice(0, JS_ERROR_STACK_LINES).join("\n");
}

/** Render a thrown/rejected value (or a console argument) as text. */
function describeValue(value: unknown): Described {
  if (value instanceof Error) {
    const message =
      value.name && value.name !== "Error" ? `${value.name}: ${value.message}` : value.message;
    return { message, stack: shortStack(value.stack) };
  }
  if (typeof value === "string") return { message: value };
  if (value === undefined) return { message: "undefined" };
  try {
    return { message: JSON.stringify(value) ?? String(value) };
  } catch {
    return { message: String(value) };
  }
}

/** A page-unique id, so a reader can tell a reloaded page's buffer apart. */
function newPageId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${random}`;
}

/**
 * A bounded, cursor-addressable buffer of JavaScript errors.
 *
 * Each record gets a monotonically increasing `seq`; {@link JsErrorBuffer.read}
 * returns the records with `seq >= since` plus the `cursor` to pass next time.
 */
export class JsErrorBuffer {
  readonly pageId: string;
  private records: JsErrorRecord[] = [];
  private nextSeq = 0;
  private dropped = 0;

  constructor(
    private readonly now: () => number = () => Date.now(),
    pageId: string = newPageId()
  ) {
    this.pageId = pageId;
  }

  /** Append one record. */
  record(kind: JsErrorRecord["kind"], described: Described): void {
    const entry: JsErrorRecord = {
      seq: this.nextSeq++,
      timestampMs: this.now(),
      kind,
      message: clip(described.message, JS_ERROR_MESSAGE_LIMIT),
    };
    if (described.stack) entry.stack = described.stack;
    this.records.push(entry);
    if (this.records.length > JS_ERROR_BUFFER_LIMIT) {
      const excess = this.records.length - JS_ERROR_BUFFER_LIMIT;
      this.records.splice(0, excess);
      this.dropped += excess;
    }
  }

  /** The records with `seq >= since` (all when omitted), oldest first. */
  read(since?: number): JsErrorsResult {
    const from = since ?? 0;
    return {
      pageId: this.pageId,
      cursor: this.nextSeq,
      dropped: this.dropped,
      errors: this.records.filter((entry) => entry.seq >= from).map((entry) => ({ ...entry })),
    };
  }
}

/**
 * Start recording into `buffer`: window `unhandledrejection` and `error`
 * events, and every `console.error` call (forwarded to the original).
 *
 * Returns an uninstall function that removes the listeners and restores
 * `console.error`.
 */
export function installJsErrorCapture(
  buffer: JsErrorBuffer,
  target: JsErrorTarget = window,
  consoleObj: JsErrorConsole = console
): () => void {
  const onRejection = (event: PromiseRejectionEvent): void => {
    buffer.record("unhandledrejection", describeValue(event.reason));
  };
  const onError = (event: ErrorEvent): void => {
    const described = describeValue(event.error ?? event.message);
    const where = event.filename
      ? ` (${event.filename}:${event.lineno ?? 0}:${event.colno ?? 0})`
      : "";
    buffer.record("error", { ...described, message: `${described.message}${where}` });
  };
  const originalError = consoleObj.error;
  const wrappedError = (...args: unknown[]): void => {
    try {
      const parts = args.map(describeValue);
      buffer.record("console.error", {
        message: parts.map((part) => part.message).join(" "),
        stack: parts.find((part) => part.stack)?.stack,
      });
    } catch {
      // Recording must never break the app's own logging.
    }
    originalError.apply(consoleObj, args);
  };

  target.addEventListener("unhandledrejection", onRejection as EventListener);
  target.addEventListener("error", onError as EventListener);
  consoleObj.error = wrappedError;

  return () => {
    target.removeEventListener("unhandledrejection", onRejection as EventListener);
    target.removeEventListener("error", onError as EventListener);
    if (consoleObj.error === wrappedError) consoleObj.error = originalError;
  };
}

/** The page-scoped buffer, created on the first {@link ensureJsErrorCapture}. */
let pageBuffer: JsErrorBuffer | undefined;

/**
 * Install the page-scoped capture once (idempotent) and return its buffer.
 * Called by the lazily loaded `TestBridge` module when test mode is on.
 */
export function ensureJsErrorCapture(): JsErrorBuffer {
  if (!pageBuffer) {
    pageBuffer = new JsErrorBuffer();
    installJsErrorCapture(pageBuffer);
  }
  return pageBuffer;
}
