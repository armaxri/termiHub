/**
 * A rejection-safe replacement for Monaco's WebKit clipboard "pre-arm" (#5383).
 *
 * monaco-editor 0.57's `BrowserClipboardService` installs a workaround on
 * Safari / WKWebView (`installWebKitWriteTextWorkaround`): on **every** `click`
 * and `keydown` on the layout service's main container it starts a
 * `navigator.clipboard.write([new ClipboardItem({ "text/plain": deferred.p })])`
 * whose text is still pending, so a later `writeText(text)` can complete it
 * while WebKit still counts the write as user-initiated. The next click cancels
 * the previous deferred.
 *
 * In this app the service is created when the startup code first touches
 * Monaco (theme registration), before any editor exists, so the main container
 * is `document.body` and every click anywhere in the window pre-arms a write.
 * Two things then leak:
 *
 * 1. Without transient user activation (the system-test bridge's synthetic
 *    clicks, or any other non-gesture event) WebKit refuses the write with a
 *    `NotAllowedError`, which Monaco logs through `console.error`.
 * 2. The next click cancels the refused write's deferred. Nothing ever attached
 *    a handler to that promise (WebKit never consumed the `ClipboardItem`), so
 *    the `CancellationError` ("Canceled") surfaces as an unhandled rejection.
 *
 * {@link armWebKitClipboardWrite} keeps the pre-arm (it is what makes Monaco's
 * copy work in WebKit) but marks the deferred as handled, treats a refusal as
 * the expected outcome of a non-gesture event — silently, and disarming the
 * pending write so a later copy uses the normal `writeText` path instead of
 * completing a write WebKit already refused — and reports only unexpected errors.
 */

/** The `name` of the error WebKit rejects a gesture-less clipboard write with. */
const NOT_ALLOWED = "NotAllowedError";

/** The `name`/`message` Monaco uses for a cancelled deferred (`CancellationError`). */
const CANCELED = "Canceled";

function canceledError(): Error {
  const error = new Error(CANCELED);
  error.name = CANCELED;
  return error;
}

/**
 * Attached to a deferred so its rejection counts as handled. Not a value
 * fallback: the outcome is still delivered to the real consumer (the
 * `ClipboardItem`), and a cancellation is the expected end of a pre-armed write.
 */
function markRejectionHandled(): void {
  // Intentionally empty — see above.
}

/** `true` for the refusal WebKit gives a clipboard write outside a user gesture. */
export function isClipboardNotAllowed(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === NOT_ALLOWED
  );
}

/**
 * The deferred clipboard text Monaco's `writeText` completes. It has the same
 * surface `BrowserClipboardService` uses on its `DeferredPromise` (`p`,
 * `isSettled`, `complete`, `cancel`), but its promise is marked handled at
 * creation, so cancelling it can never become an unhandled rejection.
 */
export class PendingClipboardText {
  readonly p: Promise<string>;
  private settled = false;
  private resolveText!: (text: string) => void;
  private rejectText!: (error: Error) => void;

  constructor() {
    this.p = new Promise<string>((resolve, reject) => {
      this.resolveText = resolve;
      this.rejectText = reject;
    });
    // The browser's `ClipboardItem` is the only real consumer, and it never
    // reads the promise when the write was refused. Without this the
    // cancellation below surfaces as an unhandled rejection.
    this.p.catch(markRejectionHandled);
  }

  get isSettled(): boolean {
    return this.settled;
  }

  /** Resolve the pending write with `text` (called by Monaco's `writeText`). */
  complete(text: string): Promise<void> {
    if (!this.settled) {
      this.settled = true;
      this.resolveText(text);
    }
    return Promise.resolve();
  }

  /** Abandon the pending write (a newer gesture superseded it). */
  cancel(): void {
    if (!this.settled) {
      this.settled = true;
      this.rejectText(canceledError());
    }
  }
}

/** The state `BrowserClipboardService` keeps for the WebKit pre-arm. */
export interface WebKitClipboardHost {
  webKitPendingClipboardWritePromise?: PendingClipboardText;
}

/**
 * Pre-arm one clipboard write for the current event. Never throws and never
 * leaves a rejection unhandled: a refusal (`NotAllowedError`) is expected for
 * non-gesture events and only disarms the pending write; any other error goes
 * to `reportError`.
 */
export function armWebKitClipboardWrite(
  host: WebKitClipboardHost,
  clipboard: Pick<Clipboard, "write"> | undefined,
  reportError: (error: unknown) => void
): void {
  // `navigator.clipboard` exists only in a secure context, `ClipboardItem` only
  // in newer engines. Without either, leave nothing pending so `writeText`
  // falls through to Monaco's own fallback.
  if (!clipboard || typeof ClipboardItem === "undefined") return;

  const current = new PendingClipboardText();
  host.webKitPendingClipboardWritePromise?.cancel();
  host.webKitPendingClipboardWritePromise = current;

  const disarm = (): void => {
    if (host.webKitPendingClipboardWritePromise === current) {
      host.webKitPendingClipboardWritePromise = undefined;
    }
    current.cancel();
  };

  let write: Promise<void>;
  try {
    write = clipboard.write([new ClipboardItem({ "text/plain": current.p })]);
  } catch (error) {
    disarm();
    if (!isClipboardNotAllowed(error)) reportError(error);
    return;
  }
  write.then(undefined, (error: unknown) => {
    // A write that failed because its own deferred was cancelled is the
    // normal "superseded by a newer event" path, not an error.
    const superseded = current.isSettled && host.webKitPendingClipboardWritePromise !== current;
    disarm();
    if (isClipboardNotAllowed(error) || superseded) return;
    reportError(error);
  });
}

/** The parts of `BrowserClipboardService` the replacement pre-arm touches. */
interface BrowserClipboardServiceInternals extends WebKitClipboardHost {
  readonly layoutService: { readonly mainContainer: HTMLElement };
  readonly logService: { error(error: unknown): void };
  _register<T extends { dispose(): void }>(disposable: T): T;
}

/** A class whose prototype carries Monaco's WebKit pre-arm installer. */
export interface WebKitClipboardServiceClass {
  prototype: { installWebKitWriteTextWorkaround?: unknown };
}

/**
 * Replace `installWebKitWriteTextWorkaround` on Monaco's
 * `BrowserClipboardService` with the rejection-safe version. Must run before
 * Monaco instantiates its services (the constructor calls the method, and only
 * on WebKit). Throws if the method is gone, so a Monaco upgrade that renames it
 * fails the unit tests instead of silently bringing the leak back.
 */
export function patchWebKitClipboardWorkaround(service: WebKitClipboardServiceClass): void {
  if (typeof service.prototype.installWebKitWriteTextWorkaround !== "function") {
    throw new Error(
      "monaco-editor's BrowserClipboardService.installWebKitWriteTextWorkaround is missing; " +
        "re-check the #5383 clipboard patch against this Monaco version"
    );
  }
  service.prototype.installWebKitWriteTextWorkaround = function (
    this: BrowserClipboardServiceInternals
  ): void {
    const container = this.layoutService.mainContainer;
    const handler = (): void => {
      const view = container.ownerDocument.defaultView ?? window;
      armWebKitClipboardWrite(this, view.navigator.clipboard, (error) =>
        this.logService.error(error)
      );
    };
    container.addEventListener("click", handler);
    container.addEventListener("keydown", handler);
    this._register({
      dispose: () => {
        container.removeEventListener("click", handler);
        container.removeEventListener("keydown", handler);
      },
    });
  };
}
