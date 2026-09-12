import { StateCreator } from "zustand";

import type { AppState } from "../appStore";

/**
 * Password-prompt domain slice (extracted under #2077 via #2300): the
 * promise-based interactive SSH/host password prompt — the open/closed flag,
 * the host/username being prompted for, the pending resolver, and the last
 * "Save password" choice, together with the {@link PasswordPromptSlice.requestPassword}
 * /{@link PasswordPromptSlice.submitPassword}/{@link PasswordPromptSlice.dismissPasswordPrompt}
 * actions that drive it. `requestPassword` returns a promise that settles when
 * the user submits (with the password) or dismisses (with `null`) the prompt.
 * Extracted verbatim from the monolithic root store as a behavior-preserving
 * Zustand slice — every action still receives the shared `set`/`get` typed
 * against the full {@link AppState}, so the public store shape and behavior are
 * unchanged. Mirrors the SSH tunnel slice (#2077) and the embedded-server /
 * macros / plugins / session-history / zoom / command-palette / http-monitors /
 * dialogs / remote-desktop-resolutions slices
 * (#2113/#2114/#2115/#2299/#2300).
 */

export interface PasswordPromptSlice {
  passwordPromptOpen: boolean;
  passwordPromptHost: string;
  passwordPromptUsername: string;
  passwordPromptResolve: ((password: string | null) => void) | null;
  /** Whether the user checked "Save password" in the last password prompt. */
  passwordPromptShouldSave: boolean;
  /**
   * Optional context line explaining *why* the prompt appeared — e.g. a stored
   * credential that the server just rejected (UX-013). Rendered as a subtitle in
   * the prompt so a re-prompt is never unexplained. Empty string when the prompt
   * opened for an ordinary first-time credential entry.
   */
  passwordPromptNotice: string;
  requestPassword: (host: string, username: string, notice?: string) => Promise<string | null>;
  submitPassword: (password: string, shouldSave?: boolean) => void;
  dismissPasswordPrompt: () => void;
}

export const createPasswordPromptSlice: StateCreator<AppState, [], [], PasswordPromptSlice> = (
  set,
  get
) => ({
  passwordPromptOpen: false,
  passwordPromptHost: "",
  passwordPromptUsername: "",
  passwordPromptResolve: null,
  passwordPromptShouldSave: false,
  passwordPromptNotice: "",

  requestPassword: (host, username, notice = "") => {
    return new Promise<string | null>((resolve) => {
      set({
        passwordPromptOpen: true,
        passwordPromptHost: host,
        passwordPromptUsername: username,
        passwordPromptResolve: resolve,
        passwordPromptShouldSave: false,
        passwordPromptNotice: notice,
      });
    });
  },

  submitPassword: (password, shouldSave = false) => {
    const { passwordPromptResolve } = get();
    if (passwordPromptResolve) passwordPromptResolve(password);
    set({
      passwordPromptOpen: false,
      passwordPromptHost: "",
      passwordPromptUsername: "",
      passwordPromptResolve: null,
      passwordPromptShouldSave: shouldSave,
      passwordPromptNotice: "",
    });
  },

  dismissPasswordPrompt: () => {
    const { passwordPromptResolve } = get();
    if (passwordPromptResolve) passwordPromptResolve(null);
    set({
      passwordPromptOpen: false,
      passwordPromptHost: "",
      passwordPromptUsername: "",
      passwordPromptResolve: null,
      passwordPromptShouldSave: false,
      passwordPromptNotice: "",
    });
  },
});
