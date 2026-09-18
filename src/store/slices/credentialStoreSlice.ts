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
 */
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
  unlockResolvers: ((unlocked: boolean) => void)[];
  /**
   * Opens the unlock dialog and returns a Promise that resolves to `true` when the
   * store is successfully unlocked, or `false` when the user cancels/skips. Callers
   * can `await` this before proceeding with a credential-dependent action.
   */
  requestUnlock: () => Promise<boolean>;
  /** Settles (and clears) every pending requestUnlock() promise. Idempotent. */
  resolveUnlock: (unlocked: boolean) => void;
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
    // If the dialog was closed without a prior resolveUnlock(true) call (i.e. the
    // user clicked Skip or dismissed the dialog), cancel any pending request.
    if (prevOpen && !open) {
      get().resolveUnlock(false);
    }
  },
  unlockResolvers: [],
  requestUnlock: () =>
    new Promise<boolean>((resolve) => {
      // Append rather than replace: two concurrent connect flows may both await
      // requestUnlock() before the dialog resolves. Every awaiting caller must
      // settle on the single dialog exit (G1) — overwriting a single resolver
      // would leave the earlier connect wedged forever.
      set((state) => ({
        unlockDialogOpen: true,
        unlockResolvers: [...state.unlockResolvers, resolve],
      }));
    }),
  resolveUnlock: (unlocked) => {
    const { unlockResolvers } = get();
    if (unlockResolvers.length === 0) return;
    // Clear first so a re-entrant resolveUnlock() (e.g. the unlocked event and a
    // dialog-close both firing) is a harmless no-op — every promise settles once.
    set({ unlockResolvers: [] });
    for (const resolve of unlockResolvers) {
      resolve(unlocked);
    }
  },
});
