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
  /** Dismiss a specific toast (or all toasts when no id is given). */
  dismiss(id?: string | number): void;
}

/**
 * The shared toast hub. Import as `import { toast } from "@/components/ui"`.
 */
export const toast: ToastApi = {
  success(message, opts) {
    return sonnerToast.success(message, {
      id: opts?.id,
      description: opts?.description,
      duration: opts?.duration,
      action: opts?.action,
    });
  },

  error(message, opts) {
    return sonnerToast.error(message, {
      id: opts?.id,
      description: opts?.description,
      duration: opts?.duration ?? PERSIST_DURATION,
      action: opts?.action,
    });
  },

  info(message, opts) {
    return sonnerToast.info(message, {
      id: opts?.id,
      description: opts?.description,
      duration: opts?.duration,
      action: opts?.action,
    });
  },

  loading(message, opts) {
    return sonnerToast.loading(message, {
      id: opts?.id,
      description: opts?.description,
      duration: opts?.duration ?? PERSIST_DURATION,
    });
  },

  promise<T>(promise: Promise<T>, messages: ToastPromiseMessages<T>): Promise<T> {
    const id = sonnerToast.loading(messages.loading);
    promise.then(
      (value) => {
        const msg =
          typeof messages.success === "function" ? messages.success(value) : messages.success;
        sonnerToast.success(msg, { id });
      },
      (error: unknown) => {
        const msg = typeof messages.error === "function" ? messages.error(error) : messages.error;
        sonnerToast.error(msg, { id, duration: PERSIST_DURATION });
      }
    );
    return promise;
  },

  dismiss(id) {
    sonnerToast.dismiss(id);
  },
};
