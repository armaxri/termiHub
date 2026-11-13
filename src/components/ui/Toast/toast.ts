import { createElement } from "react";
import { toast as sonnerToast } from "sonner";

/**
 * A single inline action button rendered on a toast (a token-styled skin over
 * sonner's `action`). Use for one-tap recovery affordances such as
 * "Reconnect failed tabs" on a partial-restore summary.
 */
export interface ToastAction {
  /** Button label. */
  label: string;
  /** Invoked when the action button is pressed. */
  onClick: () => void;
  /**
   * `data-testid` for the button's label, so a system test can press it (the
   * bridge finds elements by test id; a click on the label reaches the button).
   */
  testId?: string;
}

/** The sonner action for `action`, its label tagged with `action.testId` if set. */
function sonnerAction(action: ToastAction | undefined) {
  if (!action?.testId) return action;
  return {
    label: createElement("span", { "data-testid": action.testId }, action.label),
    onClick: action.onClick,
  };
}

/** Options accepted by the toast helpers. A thin, intentional subset of sonner. */
export interface ToastOptions {
  /** Secondary line rendered under the title. */
  description?: string;
  /**
   * Explicit id. Reuse an id to update an existing toast in place (used by
   * {@link ToastPromise} to resolve a loading toast into success/error).
   */
  id?: string | number;
  /**
   * Auto-dismiss duration in ms. Defaults follow the intent: success/info
   * auto-dismiss, errors persist until dismissed. Pass `Infinity` to persist.
   */
  duration?: number;
  /** Optional inline action button (e.g. a retry affordance). */
  action?: ToastAction;
  /**
   * `data-testid` rendered on the toast element, so a system test can assert a
   * specific toast appeared (e.g. the external-spawn outcome toasts, #4010).
   */
  testId?: string;
}

/** The success/error messages a loading toast resolves into. */
export interface ToastPromiseMessages<T> {
  /** Message shown while the promise is pending. */
  loading: string;
  /** Message shown on resolve. May derive from the resolved value. */
  success: string | ((value: T) => string);
  /** Message shown on reject. May derive from the error. */
  error: string | ((error: unknown) => string);
}

/**
 * Errors persist until the user dismisses them; sonner treats a non-finite
 * duration as "no auto-dismiss".
 */
const PERSIST_DURATION = Infinity;

/**
 * Re-dismisses scheduled for toasts dismissed by id, keyed by toast id (#4812).
 *
 * sonner mounts a new or updated toast on a `setTimeout` tick but applies a
 * dismiss on animation frames. A dismiss that lands before its toast mounted —
 * a loading toast wrapping an IPC call that resolves at once, when a frame
 * runs before the mount timer — finds nothing to remove and is lost, and a
 * loading toast has no close button, so it would stay on screen for good.
 *
 * {@link toast.dismiss} therefore repeats the dismiss on a timer scheduled
 * after the mount timer (equal-delay timers run in the order they were set),
 * so the repeat always reaches the mounted toast. Reusing the id for a new or
 * updated toast before then cancels the repeat, so it never removes the
 * toast that replaced the dismissed one.
 */
const pendingRedismiss = new Map<string | number, ReturnType<typeof setTimeout>>();

/** Cancel a scheduled re-dismiss because `id` is being shown again. */
function cancelRedismiss(id: string | number | undefined): void {
  if (id === undefined) return;
  const timer = pendingRedismiss.get(id);
  if (timer === undefined) return;
  clearTimeout(timer);
  pendingRedismiss.delete(id);
}

/** Dismiss `id` now and once more after any pending mount of it has landed. */
function dismissById(id: string | number): void {
  cancelRedismiss(id);
  sonnerToast.dismiss(id);
  pendingRedismiss.set(
    id,
    setTimeout(() => {
      pendingRedismiss.delete(id);
      sonnerToast.dismiss(id);
    }, 0)
  );
}

/**
 * Ids of the success/info toasts that may still be on screen (#5618). They are
 * transient confirmations, so {@link toast.dismissTransient} clears them when
 * something more important takes over (an error dialog). Reusing an id for an
 * error or loading toast drops it from this set.
 */
const transientIds = new Set<string | number>();

/**
 * Cap on {@link transientIds}: auto-dismissed toasts never report back, so the
 * oldest ids are dropped (they are long gone from the screen by then).
 */
const MAX_TRACKED_TRANSIENT = 50;

/** Record (or forget) `id` as a transient toast. */
function trackTransient(id: string | number | undefined, transient: boolean): void {
  if (id === undefined) return;
  transientIds.delete(id);
  if (!transient) return;
  transientIds.add(id);
  if (transientIds.size > MAX_TRACKED_TRANSIENT) {
    const oldest = transientIds.values().next().value;
    if (oldest !== undefined) transientIds.delete(oldest);
  }
}

/**
 * The termiHub toast API — a token-styled skin over sonner. Every mutating or
 * async user action that resolves in the background should surface one of these
 * so nothing resolves silently (the "reactive" pillar).
 *
 * - `success` / `info` auto-dismiss.
 * - `error` persists until dismissed.
 * - `loading` resolves in place into success/error via `loading().then(...)`
 *   or the {@link ToastApi.promise} helper — ideal for agent deploy, tunnel
 *   start, and import.
 */
export interface ToastApi {
  /** Transient success confirmation (auto-dismiss). Returns the toast id. */
  success(message: string, opts?: ToastOptions): string | number;
  /** Recoverable error. Persists until dismissed. Returns the toast id. */
  error(message: string, opts?: ToastOptions): string | number;
  /** Neutral informational message (auto-dismiss). Returns the toast id. */
  info(message: string, opts?: ToastOptions): string | number;
  /**
   * Pending/loading toast. Returns its id so a caller can resolve it in place
   * with `toast.success(msg, { id })` / `toast.error(msg, { id })`.
   */
  loading(message: string, opts?: ToastOptions): string | number;
  /**
   * Drive a full loading → success/error lifecycle from a promise. The single
   * toast updates in place as the promise settles. Returns the promise so the
   * caller can still await it.
   */
  promise<T>(promise: Promise<T>, messages: ToastPromiseMessages<T>): Promise<T>;
  /**
   * Dismiss a specific toast (or all toasts when no id is given). A dismiss by
   * id always lands, even when issued before the toast finished mounting
   * (#4812).
   */
  dismiss(id?: string | number): void;
  /**
   * Dismiss every success/info toast still showing, leaving errors and loading
   * toasts. Called when an error dialog opens, so a stale "Connected" or
   * "Saved" confirmation never sits beside the error (#5618).
   */
  dismissTransient(): void;
}

/**
 * The shared toast hub. Import as `import { toast } from "@/components/ui"`.
 */
export const toast: ToastApi = {
  success(message, opts) {
    cancelRedismiss(opts?.id);
    const id = sonnerToast.success(message, {
      id: opts?.id,
      description: opts?.description,
      duration: opts?.duration,
      action: sonnerAction(opts?.action),
      testId: opts?.testId,
    });
    trackTransient(id ?? opts?.id, true);
    return id;
  },

  error(message, opts) {
    cancelRedismiss(opts?.id);
    const id = sonnerToast.error(message, {
      id: opts?.id,
      description: opts?.description,
      duration: opts?.duration ?? PERSIST_DURATION,
      action: sonnerAction(opts?.action),
      testId: opts?.testId,
    });
    trackTransient(id ?? opts?.id, false);
    return id;
  },

  info(message, opts) {
    cancelRedismiss(opts?.id);
    const id = sonnerToast.info(message, {
      id: opts?.id,
      description: opts?.description,
      duration: opts?.duration,
      action: sonnerAction(opts?.action),
      testId: opts?.testId,
    });
    trackTransient(id ?? opts?.id, true);
    return id;
  },

  loading(message, opts) {
    cancelRedismiss(opts?.id);
    const id = sonnerToast.loading(message, {
      id: opts?.id,
      description: opts?.description,
      duration: opts?.duration ?? PERSIST_DURATION,
      action: sonnerAction(opts?.action),
      testId: opts?.testId,
    });
    trackTransient(id ?? opts?.id, false);
    return id;
  },

  promise<T>(promise: Promise<T>, messages: ToastPromiseMessages<T>): Promise<T> {
    const id = sonnerToast.loading(messages.loading);
    promise.then(
      (value) => {
        const msg =
          typeof messages.success === "function" ? messages.success(value) : messages.success;
        sonnerToast.success(msg, { id });
        trackTransient(id, true);
      },
      (error: unknown) => {
        const msg = typeof messages.error === "function" ? messages.error(error) : messages.error;
        sonnerToast.error(msg, { id, duration: PERSIST_DURATION });
      }
    );
    return promise;
  },

  dismiss(id) {
    if (id === undefined) {
      transientIds.clear();
      sonnerToast.dismiss();
      return;
    }
    transientIds.delete(id);
    dismissById(id);
  },

  dismissTransient() {
    const ids = Array.from(transientIds);
    transientIds.clear();
    for (const id of ids) dismissById(id);
  },
};
