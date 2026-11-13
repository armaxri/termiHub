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
  /**
   * Dismiss this toast as soon as a dialog opens (#5665). For a toast that
   * offers an action on what was on screen a moment ago (a "Closed … /
   * Reopen" undo): once a dialog takes over, it would only sit beside the
   * dialog, over a backdrop that blocks it.
   */
  dismissOnModal?: boolean;
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
  shownTransient.delete(id);
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

/** Ids of the toasts raised with {@link ToastOptions.dismissOnModal}. */
const modalStaleIds = new Set<string | number>();

/** Record (or forget) `id` as a toast a dialog opening dismisses. */
function trackModalStale(id: string | number | undefined, stale: boolean | undefined): void {
  if (id === undefined) return;
  modalStaleIds.delete(id);
  if (!stale) return;
  modalStaleIds.add(id);
  if (modalStaleIds.size > MAX_TRACKED_TRANSIENT) {
    const oldest = modalStaleIds.values().next().value;
    if (oldest !== undefined) modalStaleIds.delete(oldest);
  }
}

/** A success/info toast, kept so it can be taken down and shown again later. */
interface TransientSpec {
  kind: "success" | "info";
  message: string;
  opts: ToastOptions & { id: string | number };
}

/**
 * The success/info toasts on screen, by id (#5715): what
 * {@link setTransientDeferred} takes down and queues when the stack docks. A
 * toast leaves the map when it closes or is dismissed.
 */
const shownTransient = new Map<string | number, TransientSpec>();

/**
 * Success/info toasts waiting for the docked stack to undock (#5715), oldest
 * first. Keyed by id, so a newer toast with the same id replaces the older.
 */
const deferredTransient = new Map<string | number, TransientSpec>();

/** At most this many deferred toasts are kept; the oldest are dropped. */
const MAX_DEFERRED = 10;

/** Whether success/info toasts are deferred right now (#5715). */
let deferring = false;

/** Counter for ids given to toasts raised without one. */
let nextTransientId = 0;

/** `opts` with an id, generated when the caller gave none. */
function withId(opts: ToastOptions | undefined): ToastOptions & { id: string | number } {
  return { ...opts, id: opts?.id ?? `th-toast-${++nextTransientId}` };
}

/** Show (or, while deferring, queue) a success/info toast. Returns its id. */
function showTransient(spec: TransientSpec): string | number {
  const { id } = spec.opts;
  cancelRedismiss(id);
  trackTransient(id, true);
  trackModalStale(id, spec.opts.dismissOnModal);
  if (deferring) {
    deferredTransient.delete(id);
    deferredTransient.set(id, spec);
    if (deferredTransient.size > MAX_DEFERRED) {
      const oldest = deferredTransient.keys().next().value;
      if (oldest !== undefined) deferredTransient.delete(oldest);
    }
    // Take down whatever shows under this id (a loading toast resolving into
    // this one, an older copy of it).
    dismissById(id);
    return id;
  }
  shownTransient.set(id, spec);
  const forget = () => {
    if (shownTransient.get(id) === spec) shownTransient.delete(id);
  };
  const show = spec.kind === "success" ? sonnerToast.success : sonnerToast.info;
  show(spec.message, {
    id,
    description: spec.opts.description,
    duration: spec.opts.duration,
    action: sonnerAction(spec.opts.action),
    testId: spec.opts.testId,
    onDismiss: forget,
    onAutoClose: forget,
  });
  return id;
}

/** Stop tracking `id` as a success/info toast (it was dismissed or replaced). */
function forgetTransientSpec(id: string | number | undefined): void {
  if (id === undefined) return;
  deferredTransient.delete(id);
  shownTransient.delete(id);
}

/**
 * Defer success/info toasts while the toast stack is docked over a tall dialog
 * (#5715), and show them once it is not. Turning it on takes the success/info
 * toasts on screen down and queues them with the new ones; errors and loading
 * toasts stay visible throughout. Turning it off shows the queue, oldest
 * first. Called by the toast hub's layout hook.
 */
export function setTransientDeferred(on: boolean): void {
  if (on === deferring) return;
  deferring = on;
  if (on) {
    for (const [id, spec] of Array.from(shownTransient)) {
      deferredTransient.delete(id);
      deferredTransient.set(id, spec);
      dismissById(id);
    }
    return;
  }
  const queued = Array.from(deferredTransient.values());
  deferredTransient.clear();
  for (const spec of queued) showTransient(spec);
}

/**
 * Dismiss every toast raised with {@link ToastOptions.dismissOnModal}. Called
 * by the toast hub when a dialog opens (#5665).
 */
export function dismissModalStaleToasts(): void {
  const ids = Array.from(modalStaleIds);
  modalStaleIds.clear();
  for (const id of ids) {
    transientIds.delete(id);
    forgetTransientSpec(id);
    dismissById(id);
  }
}

/**
 * The termiHub toast API — a token-styled skin over sonner. Every mutating or
 * async user action that resolves in the background should surface one of these
 * so nothing resolves silently (the "reactive" pillar).
 *
 * - `success` / `info` auto-dismiss. While the stack is docked over a tall
 *   dialog they wait until it closes (#5715).
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
    return showTransient({ kind: "success", message, opts: withId(opts) });
  },

  error(message, opts) {
    cancelRedismiss(opts?.id);
    forgetTransientSpec(opts?.id);
    const id = sonnerToast.error(message, {
      id: opts?.id,
      description: opts?.description,
      duration: opts?.duration ?? PERSIST_DURATION,
      action: sonnerAction(opts?.action),
      testId: opts?.testId,
    });
    trackTransient(id ?? opts?.id, false);
    trackModalStale(id ?? opts?.id, opts?.dismissOnModal);
    return id;
  },

  info(message, opts) {
    return showTransient({ kind: "info", message, opts: withId(opts) });
  },

  loading(message, opts) {
    cancelRedismiss(opts?.id);
    forgetTransientSpec(opts?.id);
    const id = sonnerToast.loading(message, {
      id: opts?.id,
      description: opts?.description,
      duration: opts?.duration ?? PERSIST_DURATION,
      action: sonnerAction(opts?.action),
      testId: opts?.testId,
    });
    trackTransient(id ?? opts?.id, false);
    trackModalStale(id ?? opts?.id, opts?.dismissOnModal);
    return id;
  },

  promise<T>(promise: Promise<T>, messages: ToastPromiseMessages<T>): Promise<T> {
    const id = sonnerToast.loading(messages.loading);
    promise.then(
      (value) => {
        const msg =
          typeof messages.success === "function" ? messages.success(value) : messages.success;
        showTransient({ kind: "success", message: msg, opts: { id } });
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
      modalStaleIds.clear();
      deferredTransient.clear();
      shownTransient.clear();
      sonnerToast.dismiss();
      return;
    }
    transientIds.delete(id);
    modalStaleIds.delete(id);
    forgetTransientSpec(id);
    dismissById(id);
  },

  dismissTransient() {
    const ids = Array.from(transientIds);
    transientIds.clear();
    deferredTransient.clear();
    for (const id of ids) dismissById(id);
  },
};
