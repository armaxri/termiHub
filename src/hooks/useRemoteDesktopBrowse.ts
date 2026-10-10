import { useCallback, useEffect, useRef } from "react";
import {
  forgetRemoteDesktopBrowser,
  openRemoteDesktopBrowser,
  syncRemoteDesktopBrowser,
} from "@/components/RemoteDesktop/browseRemoteFiles";

/**
 * "Browse remote files" for one remote-desktop tab (#4193): open the File
 * Browser on the session's side channel and render the source the backend
 * holds for the session.
 *
 * The backend owns the registration (#4384): it re-opens it after a reconnect
 * and drops it when the session ends. This hook only mirrors it — it reads it
 * back when the tab gets its session (a tab moved in from another window, a
 * reloaded window) and after each return to live, and forgets the local entry
 * on unmount without closing anything on the backend.
 */
export function useRemoteDesktopBrowse(
  tabId: string,
  sessionId: string | null,
  live: boolean
): (dir?: string) => Promise<boolean> {
  useEffect(() => {
    if (!sessionId) return;
    void syncRemoteDesktopBrowser(tabId, sessionId);
    return () => forgetRemoteDesktopBrowser(tabId);
  }, [tabId, sessionId]);

  // A reconnect builds a new tunnel / agent link, which the backend re-opens
  // the side channel on: refresh the route line on the way back to live.
  const wasLive = useRef(live);
  useEffect(() => {
    if (live && !wasLive.current && sessionId) void syncRemoteDesktopBrowser(tabId, sessionId);
    wasLive.current = live;
  }, [tabId, sessionId, live]);

  return useCallback(
    async (dir?: string) => {
      if (!sessionId) return false;
      return await openRemoteDesktopBrowser(tabId, sessionId, dir);
    },
    [tabId, sessionId]
  );
}
