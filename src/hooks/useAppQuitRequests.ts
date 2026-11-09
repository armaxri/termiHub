import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "@/store/appStore";
import { quitWindowListening, quitWindowPrompting, quitWindowReady } from "@/services/api";
import { errorMessage } from "@/utils/errorMessage";
import { frontendError } from "@/utils/frontendLog";
import { subscribeGuarded, useTauriListener } from "./useTauriListener";

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

/**
 * Report that this window's quit listener is registered, and answer a quit that
 * is already waiting on it (#5106). Tauri delivers an event only to listeners
 * that exist when it is emitted, so a window that was still loading when Cmd+Q
 * fanned out never saw the request; without this it would be skipped.
 */
export async function catchUpOnPendingQuit(): Promise<void> {
  try {
    if (await quitWindowListening()) await handleAppQuitRequested();
  } catch (err) {
    frontendError("multi_window", `Checking for a pending app quit failed: ${errorMessage(err)}`);
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
 * the exit until every window agreed, including one that was still loading
 * when the quit began (#5106).
 */
export function useAppQuitRequests(): void {
  useEffect(() => {
    let active = true;
    const dispose = subscribeGuarded(
      async () => {
        const unlisten = await listen<void>(APP_QUIT_REQUESTED_EVENT, () => {
          if (active) void handleAppQuitRequested();
        });
        // Only once the listener exists: a request emitted from here on reaches
        // it, and one emitted before is answered by the catch-up (#5106).
        if (active) void catchUpOnPendingQuit();
        return unlisten;
      },
      "app_quit",
      `"${APP_QUIT_REQUESTED_EVENT}"`
    );
    return () => {
      active = false;
      dispose();
    };
  }, []);
  useTauriListener<void>(APP_QUIT_CANCELLED_EVENT, handleAppQuitCancelled, "app_quit");
}
