import { StateCreator } from "zustand";

import type { AppState } from "../appStore";
import { CredentialStoreStatusInfo } from "@/types/credential";
import { getCredentialStoreStatus as apiGetCredentialStoreStatus } from "@/services/api";
import { frontendLog } from "@/utils/frontendLog";
import { errorMessage } from "@/utils/errorMessage";

/**
 * Credential-store domain slice (ARCH-001/FES-011, appStore god-module split via
 * #2881): the credential-store status snapshot plus the promise-based master-
 * password unlock dialog — the open/closed flag, the list of pending
 * {@link CredentialStoreSlice.requestUnlock} resolvers, and the
 * load/set/request/resolve actions that drive them. `requestUnlock` returns a
 * promise that settles `true` when the store is unlocked or `false` when the
 * user cancels/skips the dialog; multiple concurrent connect flows can await it
 * and all settle on the single dialog exit (G1). Extracted verbatim from the
 * monolithic root store as a behavior-preserving Zustand slice — every action
 * still receives the shared `set`/`get` typed against the full {@link AppState},
 * so the public store shape and behavior are unchanged. Mirrors the SSH tunnel
 * slice (#2077) and the password-prompt / dialogs / session-history / etc.
 * slices.
 *
 * A connect can ask for the dialog with a fall-through (#5188): the dialog then
 * offers "Connect without saved password", which settles the request
 * `"skipped"` — the connect goes on to its interactive prompt with the store
 * still locked — instead of `"canceled"`.
 */

/**
 * How an unlock request settled: the store is unlocked, the user chose to
 * connect without the saved credential (only offered to a request made with
 * `connectFallback`, #5188), or the user dismissed the dialog.
 */
export type UnlockOutcome = "unlocked" | "skipped" | "canceled";

/** Options for {@link CredentialStoreSlice.requestUnlockOutcome}. */
export interface UnlockRequestOptions {
  /**
   * The request comes from a connect that can go on without the stored
   * credential by prompting for it (#5188): the dialog offers "Connect without
   * saved password" next to Unlock.
   */
  connectFallback?: boolean;
}

export interface CredentialStoreSlice {
  // Credential store
  credentialStoreStatus: CredentialStoreStatusInfo | null;
  setCredentialStoreStatus: (status: CredentialStoreStatusInfo) => void;
  loadCredentialStoreStatus: () => Promise<void>;
  unlockDialogOpen: boolean;
  setUnlockDialogOpen: (open: boolean) => void;
  /**
   * Pending resolvers for in-flight requestUnlock() calls. Internal — settled by
   * resolveUnlock(). Held as a list so that concurrent connect flows each awaiting
   * requestUnlock() all settle on a single dialog exit; a single resolver would
   * be overwritten by the second caller, wedging the first connect forever (G1).
   */
  unlockResolvers: ((outcome: UnlockOutcome) => void)[];
  /**
   * Whether the open dialog offers "Connect without saved password": some
   * pending request was made with `connectFallback` (#5188).
   */
  unlockConnectFallback: boolean;
  /**
   * Opens the unlock dialog and returns a Promise that resolves to `true` when the
   * store is successfully unlocked, or `false` when the user cancels. Callers
   * can `await` this before proceeding with a credential-dependent action.
   */
  requestUnlock: () => Promise<boolean>;
  /**
   * Opens the unlock dialog and resolves to how it settled (#5188). With
   * `connectFallback` the dialog also offers "Connect without saved password",
   * which settles `"skipped"`.
   */
  requestUnlockOutcome: (opts?: UnlockRequestOptions) => Promise<UnlockOutcome>;
  /**
   * Settles (and clears) every pending unlock request. `true`/`false` are
   * `"unlocked"`/`"canceled"`. Idempotent.
   */
  resolveUnlock: (outcome: boolean | UnlockOutcome) => void;
  /**
   * "Connect without saved password" (#5188): settle every pending request
   * `"skipped"` and close the dialog. The store stays locked.
   */
  skipUnlock: () => void;
}

export const createCredentialStoreSlice: StateCreator<AppState, [], [], CredentialStoreSlice> = (
  set,
  get
) => ({
  // Credential store
  credentialStoreStatus: null,
  setCredentialStoreStatus: (status) => set({ credentialStoreStatus: status }),
  loadCredentialStoreStatus: async () => {
    try {
      const status = await apiGetCredentialStoreStatus();
      set({ credentialStoreStatus: status });
    } catch (err) {
      frontendLog("app_store", `Failed to load credential store status: ${errorMessage(err)}`);
    }
  },
  unlockDialogOpen: false,
  setUnlockDialogOpen: (open) => {
    const prevOpen = get().unlockDialogOpen;
    set({ unlockDialogOpen: open });
    // If the dialog was closed without a prior resolveUnlock() call (the user
    // dismissed it with Escape/×/Cancel), cancel any pending request.
    if (prevOpen && !open) {
      get().resolveUnlock(false);
    }
  },
  unlockResolvers: [],
  unlockConnectFallback: false,
  requestUnlock: () =>
    get()
      .requestUnlockOutcome()
      .then((outcome) => outcome === "unlocked"),
  requestUnlockOutcome: (opts) =>
    new Promise<UnlockOutcome>((resolve) => {
      // Append rather than replace: two concurrent connect flows may both await
      // requestUnlock() before the dialog resolves. Every awaiting caller must
      // settle on the single dialog exit (G1) — overwriting a single resolver
      // would leave the earlier connect wedged forever.
      // The fall-through is offered while any waiting connect can take it; a
      // waiter that cannot (e.g. a Settings action) reads "skipped" as a cancel.
      set((state) => ({
        unlockDialogOpen: true,
        unlockResolvers: [...state.unlockResolvers, resolve],
        unlockConnectFallback: state.unlockConnectFallback || Boolean(opts?.connectFallback),
      }));
    }),
  resolveUnlock: (outcome) => {
    const { unlockResolvers } = get();
    if (unlockResolvers.length === 0) return;
    const settled: UnlockOutcome =
      outcome === true ? "unlocked" : outcome === false ? "canceled" : outcome;
    // Clear first so a re-entrant resolveUnlock() (e.g. the unlocked event and a
    // dialog-close both firing) is a harmless no-op — every promise settles once.
    set({ unlockResolvers: [], unlockConnectFallback: false });
    for (const resolve of unlockResolvers) {
      resolve(settled);
    }
  },
  skipUnlock: () => {
    // Settle first, so the close below finds nothing left to cancel.
    get().resolveUnlock("skipped");
    get().setUnlockDialogOpen(false);
  },
});
