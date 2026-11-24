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

/** `action` with `forget` run before its own handler (it closes the toast). */
function forgetting(action: ToastAction | undefined, forget: () => void): ToastAction | undefined {
  if (!action) return action;
  return {
    ...action,
    onClick: () => {
      forget();
      action.onClick();
    },
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
   * Optional second, quieter button that declines the offer and closes the
   * toast (e.g. "Not now" beside an "Install" action, #5753). It renders
   * before the action, as a ghost button. Pressing it closes the toast.
   */
  cancel?: ToastAction;
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

/**
 * The sonner id a toast id shows under now, for ids that were dismissed
 * (#5904). sonner applies a dismiss two animation frames after it is issued,
 * to whatever toast then has that id. A toast shown again under the same id
 * within those frames — a deferred success toast re-shown as the stack undocks,
 * a loading toast replaced right after its dismiss — was taken down by the
 * stale dismiss. So a dismissed id moves to a fresh sonner id: the stale
 * dismiss only ever reaches the toast it was meant for. Updating a toast that
 * is still showing keeps its sonner id, so it is replaced in place.
 */
const sonnerIds = new Map<string | number, string>();

/** At most this many moved ids are remembered; the oldest are dropped. */
const MAX_SONNER_IDS = 200;

/** Counter making each moved sonner id unique. */
let nextSonnerGeneration = 0;

/** The sonner id the toast `id` shows under. */
function sonnerIdOf(id: string | number): string | number;
function sonnerIdOf(id: string | number | undefined): string | number | undefined;
function sonnerIdOf(id: string | number | undefined): string | number | undefined {
  return id === undefined ? undefined : (sonnerIds.get(id) ?? id);
}

/** Move `id` to a fresh sonner id, out of reach of the dismiss just issued. */
function retireSonnerId(id: string | number): void {
  sonnerIds.delete(id);
  sonnerIds.set(id, `${String(id)}~${++nextSonnerGeneration}`);
  if (sonnerIds.size > MAX_SONNER_IDS) {
    const oldest = sonnerIds.keys().next().value;
    if (oldest !== undefined) sonnerIds.delete(oldest);
  }
}

/** `id`, a fresh id sonner just gave a toast, now shows under itself. */
function adoptSonnerId(id: string | number): string | number {
  sonnerIds.delete(id);
  return id;
}

/** Dismiss `id` now and once more after any pending mount of it has landed. */
function dismissById(id: string | number): void {
  cancelRedismiss(id);
  shownTransient.delete(id);
  const sonnerId = sonnerIdOf(id);
  retireSonnerId(id);
  sonnerToast.dismiss(sonnerId);
  pendingRedismiss.set(
    id,
    setTimeout(() => {
      pendingRedismiss.delete(id);
      sonnerToast.dismiss(sonnerId);
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
  /** When it went on screen (`Date.now()`), for its remaining lifetime (#5914). */
  shownAt?: number;
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

/**
 * sonner's lifetime for a toast raised without a duration (its
 * `TOAST_LIFETIME`; the `Toaster` sets none of its own).
 */
const SONNER_DEFAULT_DURATION = 4000;

/**
 * The shortest lifetime an undo offer gets when it comes back after a dialog
 * (#5914): one that was about to expire as the dialog opened still stays up
 * long enough to read and press, rather than flashing.
 */
export const MIN_RESTORED_OFFER_MS = 2000;

/** An undo offer hidden while a dialog is open (#5914). */
interface HiddenOffer {
  spec: TransientSpec;
  /** The lifetime it had left when it was hidden, in ms. */
  remaining: number;
  /** How many dialogs were open before the one that hid it. */
  level: number;
}

/**
 * Undo offers taken off screen while a dialog is open, by id (#5914). They are
 * still on offer: {@link restoreOffersAfterDialog} shows each again, with its
 * remaining lifetime, once the dialogs above it close.
 */
const hiddenOffers = new Map<string | number, HiddenOffer>();

/**
 * A success/info message an open dialog shows in its own inline status line
 * instead of a toast (#5830).
 */
export interface InlineStatus {
  /** The toast id it stands in for. */
  id: string | number;
  kind: "success" | "info";
  message: string;
  description?: string;
}

/** An open dialog's inline status line: shows a message, or clears on `null`. */
export type InlineStatusSink = (status: InlineStatus | null) => void;

/**
 * The inline status lines of the open dialogs, innermost (last opened) last
 * (#5830). While one is registered, success/info toasts without a button show
 * there instead of in the toast stack beside the dialog.
 */
const inlineSinks: InlineStatusSink[] = [];

/** The message an inline status line shows right now, and its expiry timer. */
let inlineShown: {
  id: string | number;
  sink: InlineStatusSink;
  timer: ReturnType<typeof setTimeout> | undefined;
} | null = null;

/** How long an inline status message shows unless its toast set a duration. */
export const INLINE_STATUS_DURATION = 6000;

/** Clear the inline status message (only `id`'s, when given). */
function clearInline(id?: string | number): void {
  if (!inlineShown || (id !== undefined && inlineShown.id !== id)) return;
  const { sink, timer } = inlineShown;
  if (timer !== undefined) clearTimeout(timer);
  inlineShown = null;
  sink(null);
}

/**
 * Register an open dialog's inline status line (#5830): until the returned
 * function is called, success/info toasts without an action or cancel button
 * show there instead of in the toast stack. The last registered line wins, so
 * a nested dialog takes over from the one under it.
 */
export function registerInlineStatusSink(sink: InlineStatusSink): () => void {
  inlineSinks.push(sink);
  return () => {
    const at = inlineSinks.lastIndexOf(sink);
    if (at >= 0) inlineSinks.splice(at, 1);
    if (inlineShown?.sink === sink) clearInline();
  };
}

/**
 * Whether `spec` offers a button (an undo such as "Closed … · Reopen"). Such a
 * toast is an offer, not a confirmation of something already on screen: it is
 * never moved to a dialog's status line nor held back while the stack is
 * docked (#5904), since the offer is gone once its moment passes.
 */
function offersAction(spec: TransientSpec): boolean {
  return Boolean(spec.opts.action || spec.opts.cancel);
}

/** Whether `id` is an undo offer on screen or hidden behind a dialog (#5914). */
function isOffer(id: string | number): boolean {
  const spec = shownTransient.get(id);
  return hiddenOffers.has(id) || (spec !== undefined && offersAction(spec));
}

/** Show `spec` in the innermost dialog's status line, if it can go there. */
function showInline(spec: TransientSpec): boolean {
  const sink = inlineSinks[inlineSinks.length - 1];
  if (!sink || offersAction(spec)) return false;
  const { id } = spec.opts;
  // Take down whatever shows under this id (a loading toast resolving here).
  dismissById(id);
  clearInline();
  const duration = spec.opts.duration ?? INLINE_STATUS_DURATION;
  const timer = Number.isFinite(duration) ? setTimeout(() => clearInline(id), duration) : undefined;
  inlineShown = { id, sink, timer };
  sink({ id, kind: spec.kind, message: spec.message, description: spec.opts.description });
  return true;
}

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
  const hidden = hiddenOffers.get(id);
  if (hidden) {
    hiddenOffers.delete(id);
    // An offer updated while its dialog is up (a tab closed from a confirm
    // dialog joins the reopen toast) stays hidden with it, at full lifetime.
    if (offersAction(spec)) {
      hiddenOffers.set(id, { ...hidden, spec, remaining: lifetimeOf(spec) });
      return id;
    }
  }
  if (showInline(spec)) return id;
  if (deferring && !offersAction(spec)) {
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
  const shown: TransientSpec = { ...spec, shownAt: Date.now() };
  shownTransient.set(id, shown);
  const forget = () => {
    if (shownTransient.get(id) === shown) shownTransient.delete(id);
  };
  const show = spec.kind === "success" ? sonnerToast.success : sonnerToast.info;
  show(spec.message, {
    id: sonnerIdOf(id),
    description: spec.opts.description,
    duration: spec.opts.duration,
    // Pressing either button closes the toast without sonner's onDismiss, so
    // forget it here too: otherwise it would count as on screen for good.
    action: sonnerAction(forgetting(spec.opts.action, forget)),
    cancel: sonnerAction(forgetting(spec.opts.cancel, forget)),
    testId: spec.opts.testId,
    onDismiss: forget,
    onAutoClose: forget,
  });
  return id;
}

/** Stop tracking `id` as a success/info toast (it was dismissed or replaced). */
function forgetTransientSpec(id: string | number | undefined): void {
  if (id === undefined) return;
  clearInline(id);
  deferredTransient.delete(id);
  shownTransient.delete(id);
  hiddenOffers.delete(id);
}

/**
 * Defer success/info toasts while the toast stack is docked over a tall dialog
 * (#5715), and show them once it is not. Turning it on takes the success/info
 * toasts on screen down and queues them with the new ones; errors, loading
 * toasts and toasts offering a button (an undo, #5904) stay visible throughout. Turning it off shows the queue, oldest
 * first. Called by the toast hub's layout hook.
 */
export function setTransientDeferred(on: boolean): void {
  if (on === deferring) return;
  deferring = on;
  if (on) {
    for (const [id, spec] of Array.from(shownTransient)) {
      if (offersAction(spec)) continue;
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

/** The lifetime `spec` asks for, in ms (`Infinity` when it persists). */
function lifetimeOf(spec: TransientSpec): number {
  return spec.opts.duration ?? SONNER_DEFAULT_DURATION;
}

/** The lifetime `spec`, on screen, has left now. */
function remainingLifetime(spec: TransientSpec): number {
  const lifetime = lifetimeOf(spec);
  if (!Number.isFinite(lifetime)) return lifetime;
  return lifetime - (Date.now() - (spec.shownAt ?? Date.now()));
}

/**
 * Take the undo offers on screen down while a dialog is open (#5914), keeping
 * them on offer. `level` is how many dialogs were open before this one, so a
 * nested dialog closing brings back only the offers it hid. Called by the toast
 * hub when a dialog opens; the plain confirmations go for good (#5830).
 */
export function hideOffersForDialog(level: number): void {
  for (const [id, spec] of Array.from(shownTransient)) {
    if (!offersAction(spec)) continue;
    hiddenOffers.set(id, { spec, remaining: remainingLifetime(spec), level });
    dismissById(id);
  }
}

/**
 * Show again the undo offers hidden by the dialogs that just closed (#5914):
 * those hidden at `open` dialogs or more, `open` being how many are still
 * open. Each gets the lifetime it had left when its dialog opened, at least
 * {@link MIN_RESTORED_OFFER_MS}: time spent in the dialog does not count.
 */
export function restoreOffersAfterDialog(open: number): void {
  for (const [id, hidden] of Array.from(hiddenOffers)) {
    if (hidden.level < open) continue;
    hiddenOffers.delete(id);
    const duration = Math.max(MIN_RESTORED_OFFER_MS, hidden.remaining);
    showTransient({ ...hidden.spec, opts: { ...hidden.spec.opts, duration } });
  }
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
 * - `success` / `info` auto-dismiss. While a dialog is open they show in its
 *   inline status line (#5830) unless they carry a button; while the stack is
 *   docked over a tall dialog, those without a button wait until it closes
 *   (#5715) — an undo offer shows at once (#5904).
 *   Those still showing are dismissed when a dialog opens (#5830), except
 *   undo offers: they are hidden while it is open and come back, with their
 *   remaining lifetime, once it closes (#5914).
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
   * Dismiss every success/info toast still showing, leaving errors, loading
   * toasts and undo offers (a toast with a button, #5914; the toast hub hides
   * those while a dialog is open). Called whenever a dialog opens (#5618,
   * #5830), so a stale "Connected" or "Saved" confirmation never sits beside a
   * new decision.
   */
  dismissTransient(): void;
  /**
   * Whether the success/info toast `id` is still on screen, queued to show
   * while the stack is docked (#5715), or an undo offer hidden while a dialog
   * is open (#5914). False once it auto-closed or was dismissed (by its close
   * button, by id, or — not being an offer — by a dialog opening).
   */
  isActive(id: string | number): boolean;
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
    const shown = sonnerToast.error(message, {
      id: sonnerIdOf(opts?.id),
      description: opts?.description,
      duration: opts?.duration ?? PERSIST_DURATION,
      action: sonnerAction(opts?.action),
      cancel: sonnerAction(opts?.cancel),
      testId: opts?.testId,
    });
    // Callers keep using their own id; sonner's own only when they gave none.
    const id = opts?.id ?? adoptSonnerId(shown);
    trackTransient(id, false);
    trackModalStale(id, opts?.dismissOnModal);
    return id;
  },

  info(message, opts) {
    return showTransient({ kind: "info", message, opts: withId(opts) });
  },

  loading(message, opts) {
    cancelRedismiss(opts?.id);
    forgetTransientSpec(opts?.id);
    const shown = sonnerToast.loading(message, {
      id: sonnerIdOf(opts?.id),
      description: opts?.description,
      duration: opts?.duration ?? PERSIST_DURATION,
      action: sonnerAction(opts?.action),
      cancel: sonnerAction(opts?.cancel),
      testId: opts?.testId,
    });
    // Callers keep using their own id; sonner's own only when they gave none.
    const id = opts?.id ?? adoptSonnerId(shown);
    trackTransient(id, false);
    trackModalStale(id, opts?.dismissOnModal);
    return id;
  },

  promise<T>(promise: Promise<T>, messages: ToastPromiseMessages<T>): Promise<T> {
    const id = adoptSonnerId(sonnerToast.loading(messages.loading));
    promise.then(
      (value) => {
        const msg =
          typeof messages.success === "function" ? messages.success(value) : messages.success;
        showTransient({ kind: "success", message: msg, opts: { id } });
      },
      (error: unknown) => {
        const msg = typeof messages.error === "function" ? messages.error(error) : messages.error;
        sonnerToast.error(msg, { id: sonnerIdOf(id), duration: PERSIST_DURATION });
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
      hiddenOffers.clear();
      clearInline();
      sonnerToast.dismiss();
      return;
    }
    transientIds.delete(id);
    modalStaleIds.delete(id);
    forgetTransientSpec(id);
    dismissById(id);
  },

  dismissTransient() {
    const ids = Array.from(transientIds).filter((id) => !isOffer(id));
    for (const id of ids) transientIds.delete(id);
    deferredTransient.clear();
    clearInline();
    for (const id of ids) dismissById(id);
  },

  isActive(id) {
    return (
      shownTransient.has(id) ||
      deferredTransient.has(id) ||
      hiddenOffers.has(id) ||
      inlineShown?.id === id
    );
  },
};
