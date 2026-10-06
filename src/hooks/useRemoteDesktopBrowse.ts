import { useCallback, useEffect, useRef } from "react";
import {
  closeRemoteDesktopBrowser,
  openRemoteDesktopBrowser,
  reattachRemoteDesktopBrowser,
} from "@/components/RemoteDesktop/browseRemoteFiles";

/**
 * "Browse remote files" for one remote-desktop tab (#4193): open the File
 * Browser on the session's side channel, re-attach it after a reconnect, and
 * close it with the session (or the tab).
 */
export function useRemoteDesktopBrowse(
  tabId: string,
  sessionId: string | null,
  live: boolean
): (dir?: string) => Promise<boolean> {
  // The source closes with its session: a new session id, or the tab going away.
  useEffect(() => {
    if (!sessionId) return;
    return () => closeRemoteDesktopBrowser(tabId);
  }, [tabId, sessionId]);

  // A reconnect builds a new tunnel / agent link: re-register on the way back
  // to live (not on the first activation — nothing is open then).
  const wasLive = useRef(live);
  useEffect(() => {
    if (live && !wasLive.current) void reattachRemoteDesktopBrowser(tabId);
    wasLive.current = live;
  }, [tabId, live]);

  return useCallback(
    async (dir?: string) => {
      if (!sessionId) return false;
      return await openRemoteDesktopBrowser(tabId, sessionId, dir);
    },
    [tabId, sessionId]
  );
}
