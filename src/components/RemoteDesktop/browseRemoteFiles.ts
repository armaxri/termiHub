/**
 * "Browse remote files" of a remote-desktop tab (#4193, concept
 * `vnc-clipboard-file-transfer` phase 3): open the existing File Browser
 * sidebar on the session's file side channel, at a folder. Downloads, uploads,
 * progress and cancel are the File Browser's and the Transfers queue's own.
 */

import { toast } from "@/components/ui";
import {
  remoteDesktopFileBrowserSource,
  remoteDesktopOpenFileBrowser,
  sessionListFiles,
} from "@/services/api";
import { useAppStore } from "@/store/appStore";
import { useRemoteDesktopBrowseStore } from "@/store/remoteDesktopBrowseStore";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";
import { compareNames } from "@/utils/locale";

/** Show the Files sidebar (expanding it if collapsed) without toggling it shut. */
function showFilesSidebar(): void {
  const { sidebarView, sidebarCollapsed, setSidebarView } = useAppStore.getState();
  if (sidebarView !== "files" || sidebarCollapsed) setSidebarView("files");
}

/**
 * Register the side channel of `sessionId` as the File Browser source of tab
 * `tabId` and open it at `dir` (default: the session's upload folder). When
 * `reveal` is false the source is refreshed without showing the sidebar (a
 * reconnect re-registering the new tunnel). A refusal (view-only, off,
 * unreachable, missing folder) is toasted. Resolves whether it opened.
 */
export async function openRemoteDesktopBrowser(
  tabId: string,
  sessionId: string,
  dir?: string,
  reveal = true
): Promise<boolean> {
  try {
    const opened = await remoteDesktopOpenFileBrowser(sessionId, dir);
    useRemoteDesktopBrowseStore.getState().openSource(tabId, {
      sessionId,
      channel: opened.channel,
      dir: opened.startDir,
    });
    if (reveal) showFilesSidebar();
    return true;
  } catch (err) {
    frontendLog("remote_desktop_files", `open file browser failed: ${errorMessage(err)}`);
    toast.error(`Cannot browse remote files: ${errorMessage(err)}`, {
      testId: "remote-desktop-browse-error",
    });
    return false;
  }
}

/**
 * Render the source the backend has open for `sessionId` in tab `tabId`
 * (#4384), without showing the sidebar. The backend owns the registration: it
 * re-opens it after a reconnect and drops it when the session ends, so this
 * is how a tab moved in from another window, a reloaded window, or a
 * reconnected session picks it up (keeping the folder of a source already
 * shown here). Nothing open on the backend changes nothing here (a browse
 * the user starts meanwhile is not undone). Logged, not toasted, on failure.
 */
export async function syncRemoteDesktopBrowser(tabId: string, sessionId: string): Promise<void> {
  try {
    const open = await remoteDesktopFileBrowserSource(sessionId);
    if (!open) return;
    const store = useRemoteDesktopBrowseStore.getState();
    const current = store.sources[tabId];
    if (current?.sessionId === sessionId) {
      store.refreshSource(tabId, open.channel);
    } else {
      store.openSource(tabId, { sessionId, channel: open.channel, dir: open.startDir });
    }
  } catch (err) {
    frontendLog("remote_desktop_files", `sync file browser failed: ${errorMessage(err)}`);
  }
}

/**
 * Forget the File Browser source of tab `tabId` in this window (the tab
 * unmounted, or its session changed). The backend registration is not
 * touched: it belongs to the session and closes when the session ends
 * (#4384) — a tab moving to another window or a stale window's tab closing
 * must not take it away from the window still showing it.
 */
export function forgetRemoteDesktopBrowser(tabId: string): void {
  useRemoteDesktopBrowseStore.getState().closeSource(tabId);
}

/** One folder level of the side-channel host, for the folder picker (#4204). */
export interface RemoteFolderListing {
  /** The absolute folder listed (a typed `~/…` resolved). */
  path: string;
  /** Its sub-folders, by name. */
  folders: { name: string; path: string }[];
}

/**
 * List the sub-folders of `dir` on a graphical session's side channel, for
 * "Upload to folder…" (#4204). Opens the side channel at `dir` first — which
 * checks the folder exists and resolves a leading `~` — then lists it through
 * the session layer like the File Browser does. Rejects with the route's
 * error (view-only, off, unreachable, missing folder).
 */
export async function listRemoteFolders(
  sessionId: string,
  dir: string
): Promise<RemoteFolderListing> {
  const opened = await remoteDesktopOpenFileBrowser(sessionId, dir);
  const entries = await sessionListFiles(sessionId, opened.startDir);
  const folders = entries
    .filter((e) => e.isDirectory)
    .map((e) => ({ name: e.name, path: e.path }))
    .sort((a, b) => compareNames(a.name, b.name));
  return { path: opened.startDir, folders };
}
