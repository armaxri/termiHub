import { StateCreator } from "zustand";

import type { AppState } from "../appStore";

/**
 * Password-prompt domain slice (extracted under #2077 via #2300): the
 * promise-based interactive SSH/host password prompt — a FIFO queue of pending
 * requests (#4312) whose head is shown, the head's host/username mirrored for
 * the UI, and the last settled "Save password" choice, together with the {@link PasswordPromptSlice.requestPassword}
 * /{@link PasswordPromptSlice.submitPassword}/{@link PasswordPromptSlice.dismissPasswordPrompt}
 * actions that drive it. `requestPassword` returns a promise that settles when
 * the user submits (with the password) or dismisses (with `null`) the prompt,
 * or rejects when the caller aborts it. Concurrent requests queue instead of
 * replacing each other, so no request's promise is ever orphaned (FES2-001).
 * Extracted verbatim from the monolithic root store as a behavior-preserving
 * Zustand slice — every action still receives the shared `set`/`get` typed
 * against the full {@link AppState}, so the public store shape and behavior are
 * unchanged. Mirrors the SSH tunnel slice (#2077) and the embedded-server /
 * macros / plugins / session-history / zoom / command-palette / http-monitors /
 * dialogs / remote-desktop-resolutions slices
 * (#2113/#2114/#2115/#2299/#2300).
 */

/**
 * Which kind of secret the prompt is asking for. An SSH **key passphrase**
 * unlocks a private key file; it is not the remote account's login password, so
 * the prompt must be labeled accordingly (UX-010). `"password"` covers the
 * ordinary account/host password.
 */
export type PasswordPromptKind = "password" | "key_passphrase";

/** Per-request options for {@link PasswordPromptSlice.requestPassword}. */
export interface PasswordPromptOptions {
  /**
   * Whether the prompt may offer its "Save password" control. Defaults to
   * `true`. A caller that never persists the entered secret — e.g. Test
   * Connection (#3316) — passes `false` so the prompt shows no no-op Save box,
   * and a submit from such a prompt never reports `shouldSave`.
   */
  allowSave?: boolean;
  /**
   * Name of the connection (or agent) the prompt is for, shown in the prompt's
   * title so that, with several prompts queued (#4312), the user can tell which
   * one they are answering. Empty / omitted falls back to the generic title.
   */
  label?: string;
  /**
   * Aborts the request when the owning connect is canceled or its tab closes
   * (#4312). A queued or on-screen request is removed and its promise rejects
   * with an `AbortError` (see {@link isPasswordPromptAbort}); a request that
   * has already settled is unaffected.
   */
  signal?: AbortSignal;
}

/** One queued password-prompt request, as the prompt UI sees it (#4312). */
export interface PasswordPromptRequest {
  /** Unique, increasing request id — lets the UI reset its fields per prompt. */
  id: number;
  host: string;
  username: string;
  notice: string;
  kind: PasswordPromptKind;
  allowSave: boolean;
  label: string;
}

/** A queued request together with the private handles that settle it. */
export interface PendingPasswordPrompt extends PasswordPromptRequest {
  resolve: (password: string | null) => void;
  reject: (reason: unknown) => void;
  /** Removes the abort listener, if any. */
  detach: () => void;
}

const ABORT_MESSAGE = "Password prompt aborted";

/** Whether `err` is the rejection of an aborted password-prompt request. */
export function isPasswordPromptAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

export interface PasswordPromptSlice {
  /**
   * Pending prompt requests, FIFO (#4312). The head is the prompt on screen;
   * the rest wait their turn. A second request never replaces the first, so
   * every `requestPassword` promise settles exactly once.
   */
  passwordPromptQueue: PendingPasswordPrompt[];
  /** Whether a prompt is on screen (the queue is non-empty). */
  passwordPromptOpen: boolean;
  /** Host of the prompt on screen (the queue head). */
  passwordPromptHost: string;
  /** Username of the prompt on screen (the queue head). */
  passwordPromptUsername: string;
  /**
   * The "Save password" choice of the most recently settled request — set
   * synchronously as that request settles, before its promise's continuations
   * run. A caller reads it right after awaiting its own `requestPassword`
   * (without awaiting anything else in between) and so sees its own choice
   * even when several prompts are queued (#4312).
   */
  passwordPromptShouldSave: boolean;
  /**
   * Optional context line explaining *why* the prompt appeared — e.g. a stored
   * credential that the server just rejected (UX-013). Rendered as a subtitle in
   * the prompt so a re-prompt is never unexplained. Empty string when the prompt
   * opened for an ordinary first-time credential entry.
   */
  passwordPromptNotice: string;
  /**
   * Which secret is being requested, so the prompt can label itself correctly
   * (UX-010): a key passphrase is not the account password. Defaults to
   * `"password"`.
   */
  passwordPromptKind: PasswordPromptKind;
  /**
   * Whether the open prompt may offer its "Save password" control (#3316).
   * `false` when the requesting flow never persists the secret. Defaults to
   * `true`.
   */
  passwordPromptAllowSave: boolean;
  /** Connection name of the prompt on screen, or `""` (#4312). */
  passwordPromptLabel: string;
  requestPassword: (
    host: string,
    username: string,
    notice?: string,
    kind?: PasswordPromptKind,
    options?: PasswordPromptOptions
  ) => Promise<string | null>;
  /** Answers the prompt on screen and shows the next queued one, if any. */
  submitPassword: (password: string, shouldSave?: boolean) => void;
  /** Cancels the prompt on screen only (resolving it with `null`). */
  dismissPasswordPrompt: () => void;
}

/** The on-screen fields mirrored from the queue head (closed when empty). */
function headFields(queue: PendingPasswordPrompt[]) {
  const head = queue[0];
  return {
    passwordPromptQueue: queue,
    passwordPromptOpen: head !== undefined,
    passwordPromptHost: head?.host ?? "",
    passwordPromptUsername: head?.username ?? "",
    passwordPromptNotice: head?.notice ?? "",
    passwordPromptKind: head?.kind ?? ("password" as PasswordPromptKind),
    passwordPromptAllowSave: head?.allowSave ?? true,
    passwordPromptLabel: head?.label ?? "",
  };
}

let nextPromptId = 1;

export const createPasswordPromptSlice: StateCreator<AppState, [], [], PasswordPromptSlice> = (
  set,
  get
) => {
  /** Remove the head request and show the next one; returns the removed head. */
  const shiftHead = (shouldSave: boolean): PendingPasswordPrompt | undefined => {
    const [head, ...rest] = get().passwordPromptQueue;
    if (!head) return undefined;
    head.detach();
    set({
      ...headFields(rest),
      // A prompt that offered no Save control can never report a save (#3316).
      passwordPromptShouldSave: head.allowSave && shouldSave,
    });
    return head;
  };

  return {
    ...headFields([]),
    passwordPromptShouldSave: false,

    requestPassword: (host, username, notice = "", kind = "password", options = {}) => {
      return new Promise<string | null>((resolve, reject) => {
        const { signal } = options;
        if (signal?.aborted) {
          reject(new DOMException(ABORT_MESSAGE, "AbortError"));
          return;
        }
        const id = nextPromptId++;
        const onAbort = () => {
          const queue = get().passwordPromptQueue;
          // Already answered or dismissed: the request has settled, nothing to do.
          if (!queue.some((r) => r.id === id)) return;
          set(headFields(queue.filter((r) => r.id !== id)));
          reject(new DOMException(ABORT_MESSAGE, "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        const request: PendingPasswordPrompt = {
          id,
          host,
          username,
          notice,
          kind,
          allowSave: options.allowSave ?? true,
          label: options.label ?? "",
          resolve,
          reject,
          detach: () => signal?.removeEventListener("abort", onAbort),
        };
        const queue = [...get().passwordPromptQueue, request];
        set(
          queue.length === 1
            ? // A fresh prompt starts with Save unchecked until answered.
              { ...headFields(queue), passwordPromptShouldSave: false }
            : { passwordPromptQueue: queue }
        );
      });
    },

    submitPassword: (password, shouldSave = false) => {
      shiftHead(shouldSave)?.resolve(password);
    },

    dismissPasswordPrompt: () => {
      shiftHead(false)?.resolve(null);
    },
  };
};
