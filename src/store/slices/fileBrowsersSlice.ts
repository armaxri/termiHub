import { StateCreator } from "zustand";

import { sessionListFiles, sessionStat, localListDir } from "@/services/api";
import { currentFileBrowsersView, mirrorFileBrowserIntent } from "@/store/fileBrowsersBridge";

import type { AppState, FileClipboard } from "../appStore";
import { errorMessage } from "@/utils/errorMessage";
import { parseBackendError } from "@/utils/backendErrorCode";
import type { IpcErrorCode } from "@/types/generated/IpcErrorCode";
import type { FileEntry } from "@/types/connection";
import { parentDir } from "@/utils/paths";

const AGENT_OUTDATED_CODE: IpcErrorCode = "agent_outdated";

/**
 * Shown instead of a listing error when the session's remote agent predates
 * agent-hosted session file browsing (#3242).
 */
export const FILES_AGENT_OUTDATED_MESSAGE =
  "This session runs on a remote agent that is too old to browse its files. " +
  "Update the agent on this host, then reconnect the session.";

/**
 * The message a failed session listing shows: an outdated remote agent gets
 * an actionable "update the agent" text, anything else its own message.
 */
export function sessionListErrorMessage(err: unknown): string {
  if (parseBackendError(err).code === AGENT_OUTDATED_CODE) {
    return FILES_AGENT_OUTDATED_MESSAGE;
  }
  return errorMessage(err);
}

// Per-pane monotonic request sequence for the file-browser list operations
// (SM-007). A directory listing is async: if the user navigates from folder A to
// folder B while A's listing is still in flight and A's response resolves *last*,
// its terminal `loadSucceeded`/`loadFailed` would clobber B and land the browser
// back on the folder the user already left. Each navigate/refresh captures the
// counter it issued under and, on resolve, applies its terminal transition only
// when that value is still the latest issued for the pane — otherwise the response
// is a stale sibling and is dropped silently (last-write-wins by request order,
// not by resolution order). The counters are per-pane and independent so an
// interleaved local-vs-session navigation never cross-cancels. Dropping a stale
// response deliberately does NOT touch loading state: the newest still-pending
// request's own resolve is what clears the spinner, so a stale drop must leave
// `loading` untouched rather than falsely clear it.
let localFileBrowserRequestSeq = 0;
let sessionFileBrowserRequestSeq = 0;

// The directory the newest in-flight listing of each pane is loading, or `null`
// when none is in flight. A refresh issued while a navigation is still loading
// must re-list the navigation's *target*, not the pane's last-shown path: the
// refresh claims the newest request slot, so the navigation's own result is then
// dropped as stale — and a refresh of the old path would land the pane back on
// the directory the user was leaving (or, right after a session switch, on the
// previous session's directory). Cleared when the newest request settles.
let localPendingPath: string | null = null;
let sessionPending: { sessionId: string; path: string } | null = null;

// The session whose listing the session pane currently shows. The pane is one
// shared view across sessions, so after the active session changes its path and
// entries still belong to the previous session until a listing for the new one
// lands. Readers use {@link sessionPaneLoadedFor} to tell "already loaded" from
// "showing another session's directory".
let sessionPaneOwner: string | null = null;

/**
 * Whether the session pane is known to show a listing of a session other than
 * `sessionId` — i.e. the active session changed and no listing for it has landed
 * yet. `false` while no listing has been recorded at all.
 */
export function sessionPaneShowsOtherSession(sessionId: string): boolean {
  return sessionPaneOwner !== null && sessionPaneOwner !== sessionId;
}

/** Reset the module-level request bookkeeping (tests only). */
export function resetFileBrowserRequestStateForTest(): void {
  localFileBrowserRequestSeq = 0;
  sessionFileBrowserRequestSeq = 0;
  localPendingPath = null;
  sessionPending = null;
  sessionPaneOwner = null;
}

/**
 * The real directory a session listing of `requested` showed. A session that
 * reports no cwd (an SFTP-only or FTP host) starts at the symbolic home `~`,
 * which the backend resolves; the pane must record the absolute directory, or
 * "up", breadcrumbs and uploads (which join names onto the pane path and go
 * through transfer channels that do not expand `~`) act on `~` literally. Every
 * listed entry's parent is that directory; an empty home asks the backend to
 * stat `~`, and keeps `~` when it cannot.
 */
export async function resolveSessionListedPath(
  sessionId: string,
  requested: string,
  entries: FileEntry[]
): Promise<string> {
  if (requested !== "~") return requested;
  if (entries.length > 0) return parentDir(entries[0].path);
  try {
    const home = await sessionStat(sessionId, "~");
    return home?.path && home.path !== "~" ? home.path : requested;
  } catch {
    return requested;
  }
}

/**
 * SFTP / local file-browser domain slice — the first cut of the appStore
 * god-module split (ARCH-001 / FES-011).
 *
 * The view (active pane, per-pane cwd/listing/loading/error, and the copy-cut
 * clipboard) does NOT live here (#2283): it is owned by the backend
 * `FileBrowserStore` and projected through the authoritative client-scoped
 * `file-browser@<clientId>` region. Readers source it from the region via
 * {@link import("../useProjectedFileBrowsers").useProjectedFileBrowsers}
 * (components) or {@link import("../fileBrowsersBridge").currentFileBrowsersView}
 * (store-side). The actions below do the async list op and report each transition
 * through a granular `fileBrowser.*` intent, which the bridge overlays
 * optimistically and the store confirms. The only local state is
 * `sessionFileBrowserId` — the per-client pointer to the active terminal session
 * used for session-based file browsing (see the field doc below).
 */
export interface FileBrowsersSlice {
  // Local file browser
  navigateLocal: (path: string) => Promise<void>;
  refreshLocal: () => Promise<void>;

  // Session-based file browser (for remote-session tabs)
  /**
   * Terminal session ID used for session-based file browsing. This is the backend
   * session model — a per-client pointer to the active terminal session, set
   * imperatively from the active tab — not part of the projected view, so it stays
   * an `appStore` field (it gates `isConnected` and targets the session file ops).
   */
  sessionFileBrowserId: string | null;
  navigateSession: (sessionId: string, path: string) => Promise<void>;
  refreshSession: () => Promise<void>;
  setSessionFileBrowserId: (sessionId: string | null) => void;

  // File browser mode
  setFileBrowserMode: (mode: "local" | "session" | "none") => void;

  /**
   * Dismiss a pane's failed-listing error banner without re-listing (SM-008).
   * Clears only the pane's `error`, leaving its last-good path/listing intact —
   * the recovery counterpart to `refreshLocal`/`refreshSession` (Retry).
   */
  clearFileBrowserError: (pane: "local" | "session") => void;

  // File clipboard (copy/cut)
  setFileClipboard: (clipboard: FileClipboard | null) => void;
}

export const createFileBrowsersSlice: StateCreator<AppState, [], [], FileBrowsersSlice> = (
  set,
  get
) => ({
  // File browser — the view is owned by the authoritative `file-browser` region
  // (#2283). Each action does the async list op and reports its transitions
  // through granular `fileBrowser.*` intents; the bridge overlays them
  // optimistically (gap-free loading/pane/clipboard feedback) and the backend
  // `FileBrowserStore` confirms. There is no local slice to `set` — every reader
  // sources the view from the region via `useProjectedFileBrowsers()` /
  // `currentFileBrowsersView()`.

  // Local file browser
  navigateLocal: async (path: string) => {
    // Normalize Windows backslashes to forward slashes so path manipulation
    // in the frontend (navigateUp, path join) works uniformly on all platforms.
    // Also expand bare drive letters (e.g. "C:") to their root form ("C:/")
    // so the Up button can reliably detect the drive root boundary.
    let normalizedPath = path.replace(/\\/g, "/");
    if (/^[A-Za-z]:$/.test(normalizedPath)) {
      normalizedPath = normalizedPath + "/";
    }
    // Claim the latest local-pane request slot (SM-007): a slower earlier
    // listing that resolves after this one must not overwrite it.
    const requestSeq = ++localFileBrowserRequestSeq;
    localPendingPath = normalizedPath;
    mirrorFileBrowserIntent("fileBrowser.loadStarted", { pane: "local" });
    try {
      const entries = await localListDir(normalizedPath);
      if (requestSeq !== localFileBrowserRequestSeq) return;
      localPendingPath = null;
      mirrorFileBrowserIntent("fileBrowser.loadSucceeded", {
        pane: "local",
        path: normalizedPath,
        entries,
      });
    } catch (err) {
      if (requestSeq !== localFileBrowserRequestSeq) return;
      localPendingPath = null;
      const message = errorMessage(err);
      mirrorFileBrowserIntent("fileBrowser.loadFailed", { pane: "local", error: message });
    }
  },

  refreshLocal: async () => {
    // Re-list an in-flight navigation's target rather than the path it is
    // leaving (see `localPendingPath`).
    const localCurrentPath = localPendingPath ?? currentFileBrowsersView().local.path;
    const requestSeq = ++localFileBrowserRequestSeq;
    localPendingPath = localCurrentPath;
    mirrorFileBrowserIntent("fileBrowser.loadStarted", { pane: "local" });
    try {
      const entries = await localListDir(localCurrentPath);
      if (requestSeq !== localFileBrowserRequestSeq) return;
      localPendingPath = null;
      mirrorFileBrowserIntent("fileBrowser.loadSucceeded", {
        pane: "local",
        path: localCurrentPath,
        entries,
      });
    } catch (err) {
      if (requestSeq !== localFileBrowserRequestSeq) return;
      localPendingPath = null;
      const message = errorMessage(err);
      mirrorFileBrowserIntent("fileBrowser.loadFailed", { pane: "local", error: message });
    }
  },

  // Session-based file browser
  sessionFileBrowserId: null,
  setSessionFileBrowserId: (sessionId) => set({ sessionFileBrowserId: sessionId }),

  navigateSession: async (sessionId: string, path: string) => {
    // Claim the latest session-pane request slot (SM-007): a slower earlier
    // listing that resolves after this one must not overwrite it.
    const requestSeq = ++sessionFileBrowserRequestSeq;
    sessionPending = { sessionId, path };
    mirrorFileBrowserIntent("fileBrowser.loadStarted", { pane: "session" });
    try {
      const entries = await sessionListFiles(sessionId, path);
      const listedPath = await resolveSessionListedPath(sessionId, path, entries);
      if (requestSeq !== sessionFileBrowserRequestSeq) return;
      sessionPending = null;
      sessionPaneOwner = sessionId;
      mirrorFileBrowserIntent("fileBrowser.loadSucceeded", {
        pane: "session",
        path: listedPath,
        entries,
      });
    } catch (err) {
      if (requestSeq !== sessionFileBrowserRequestSeq) return;
      sessionPending = null;
      const message = sessionListErrorMessage(err);
      mirrorFileBrowserIntent("fileBrowser.loadFailed", { pane: "session", error: message });
    }
  },

  refreshSession: async () => {
    const { sessionFileBrowserId } = get();
    if (!sessionFileBrowserId) return;
    // Which directory to re-list: an in-flight navigation's target (see
    // `sessionPending`); else, when the pane is known to show another
    // session's directory, this session's home (the same start the
    // auto-navigate uses); else the shown path.
    const sessionCurrentPath =
      sessionPending?.sessionId === sessionFileBrowserId
        ? sessionPending.path
        : sessionPaneShowsOtherSession(sessionFileBrowserId)
          ? "~"
          : currentFileBrowsersView().session.path;
    const requestSeq = ++sessionFileBrowserRequestSeq;
    sessionPending = { sessionId: sessionFileBrowserId, path: sessionCurrentPath };
    mirrorFileBrowserIntent("fileBrowser.loadStarted", { pane: "session" });
    try {
      const entries = await sessionListFiles(sessionFileBrowserId, sessionCurrentPath);
      const listedPath = await resolveSessionListedPath(
        sessionFileBrowserId,
        sessionCurrentPath,
        entries
      );
      if (requestSeq !== sessionFileBrowserRequestSeq) return;
      sessionPending = null;
      sessionPaneOwner = sessionFileBrowserId;
      mirrorFileBrowserIntent("fileBrowser.loadSucceeded", {
        pane: "session",
        path: listedPath,
        entries,
      });
    } catch (err) {
      if (requestSeq !== sessionFileBrowserRequestSeq) return;
      sessionPending = null;
      const message = sessionListErrorMessage(err);
      mirrorFileBrowserIntent("fileBrowser.loadFailed", { pane: "session", error: message });
    }
  },

  // File browser mode
  setFileBrowserMode: (mode) => {
    mirrorFileBrowserIntent("fileBrowser.setMode", { mode });
  },

  // Dismiss a pane's failed-listing error (SM-008) — a client-originated
  // transition with no async list op, unlike navigate/refresh.
  clearFileBrowserError: (pane) => {
    mirrorFileBrowserIntent("fileBrowser.clearError", { pane });
  },

  // File clipboard (copy/cut)
  setFileClipboard: (clipboard) => {
    mirrorFileBrowserIntent("fileBrowser.setClipboard", { clipboard });
  },
});
