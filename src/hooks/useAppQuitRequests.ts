import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "@/store/appStore";
import { quitWindowPrompting, quitWindowReady } from "@/services/api";
import { errorMessage } from "@/utils/errorMessage";
import { frontendError } from "@/utils/frontendLog";

/** Backend event: an explicit app quit (Cmd+Q / menu Quit) needs this window's answer. */
export const APP_QUIT_REQUESTED_EVENT = "app-quit-requested";
/** Backend event: a pending app quit was cancelled in some window. */
export const APP_QUIT_CANCELLED_EVENT = "app-quit-cancelled";

/**
 * Answer an app quit request for this window (#4296). A window with nothing to
 * lose agrees straight away; one that would lose a non-persistent session or an
 * unsaved editor raises the close decision dialog in quit mode and tells the
 * backend it is prompting, so the quit waits for the user. A repeated request
 * while the quit dialog is already up only re-acknowledges it.
 */
export async function handleAppQuitRequested(): Promise<void> {
  const store = useAppStore.getState();
  try {
    if (store.pendingWindowClose?.mode === "quit") {
      await quitWindowPrompting();
      return;
    }
    if (store.prepareAppQuit() === "ready") {
      await quitWindowReady();
    } else {
      await quitWindowPrompting();
    }
  } catch (err) {
    frontendError("multi_window", `Answering the app quit request failed: ${errorMessage(err)}`);
  }
}

/** Drop this window's quit dialog after the quit was cancelled elsewhere (#4296). */
export function handleAppQuitCancelled(): void {
  const store = useAppStore.getState();
  if (store.pendingWindowClose?.mode === "quit") store.setPendingWindowClose(null);
}

/**
 * Route explicit app quits (Cmd+Q, the app menu's Quit) through the same
 * detach-vs-terminate decision a window close uses (#4296). The backend holds
 * the exit until every window agreed.
 */
export function useAppQuitRequests(): void {
  useEffect(() => {
    const unlistenRequested = listen<void>(APP_QUIT_REQUESTED_EVENT, () => {
      void handleAppQuitRequested();
    });
    const unlistenCancelled = listen<void>(APP_QUIT_CANCELLED_EVENT, handleAppQuitCancelled);
    return () => {
      void unlistenRequested.then((fn) => fn());
      void unlistenCancelled.then((fn) => fn());
    };
  }, []);
}
