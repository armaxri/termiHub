/**
 * "Browse remote files" of a remote-desktop tab (#4193, concept
 * `vnc-clipboard-file-transfer` phase 3): open the existing File Browser
 * sidebar on the session's file side channel, at a folder. Downloads, uploads,
 * progress and cancel are the File Browser's and the Transfers queue's own.
 */

import { toast } from "@/components/ui";
import {
  remoteDesktopCloseFileBrowser,
  remoteDesktopOpenFileBrowser,
  sessionListFiles,
} from "@/services/api";
import { useAppStore } from "@/store/appStore";
import { useRemoteDesktopBrowseStore } from "@/store/remoteDesktopBrowseStore";
import { errorMessage } from "@/utils/errorMessage";
import { fireAndForget, frontendLog } from "@/utils/frontendLog";

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
 * Re-register an open source after its session reconnected (a new tunnel or
 * agent link), keeping the folder the user is in. Logged, not toasted, on
 * failure: the File Browser shows the route's error on its next listing.
 */
export async function reattachRemoteDesktopBrowser(tabId: string): Promise<void> {
  const source = useRemoteDesktopBrowseStore.getState().sources[tabId];
  if (!source) return;
  try {
    const opened = await remoteDesktopOpenFileBrowser(source.sessionId);
    useRemoteDesktopBrowseStore.getState().refreshSource(tabId, opened.channel);
  } catch (err) {
    frontendLog("remote_desktop_files", `re-attach file browser failed: ${errorMessage(err)}`);
  }
}

/**
 * Close the File Browser source of tab `tabId` (its session closed or ended):
 * forget it here and on the backend. A no-op when none is open.
 */
export function closeRemoteDesktopBrowser(tabId: string): void {
  const source = useRemoteDesktopBrowseStore.getState().sources[tabId];
  if (!source) return;
  useRemoteDesktopBrowseStore.getState().closeSource(tabId);
  fireAndForget(
    remoteDesktopCloseFileBrowser(source.sessionId),
    "close remote desktop file browser"
  );
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
    .sort((a, b) => a.name.localeCompare(b.name));
  return { path: opened.startDir, folders };
}
