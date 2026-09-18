import { StateCreator } from "zustand";

import { sessionListFiles, localListDir } from "@/services/api";
import { currentFileBrowsersView, mirrorFileBrowserIntent } from "@/store/fileBrowsersBridge";

import type { AppState, FileClipboard } from "../appStore";
import { errorMessage } from "@/utils/errorMessage";

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
    mirrorFileBrowserIntent("fileBrowser.loadStarted", { pane: "local" });
    try {
      const entries = await localListDir(normalizedPath);
      if (requestSeq !== localFileBrowserRequestSeq) return;
      mirrorFileBrowserIntent("fileBrowser.loadSucceeded", {
        pane: "local",
        path: normalizedPath,
        entries,
      });
    } catch (err) {
      if (requestSeq !== localFileBrowserRequestSeq) return;
      const message = errorMessage(err);
      mirrorFileBrowserIntent("fileBrowser.loadFailed", { pane: "local", error: message });
    }
  },

  refreshLocal: async () => {
    const localCurrentPath = currentFileBrowsersView().local.path;
    const requestSeq = ++localFileBrowserRequestSeq;
    mirrorFileBrowserIntent("fileBrowser.loadStarted", { pane: "local" });
    try {
      const entries = await localListDir(localCurrentPath);
      if (requestSeq !== localFileBrowserRequestSeq) return;
      mirrorFileBrowserIntent("fileBrowser.loadSucceeded", {
        pane: "local",
        path: localCurrentPath,
        entries,
      });
    } catch (err) {
      if (requestSeq !== localFileBrowserRequestSeq) return;
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
    mirrorFileBrowserIntent("fileBrowser.loadStarted", { pane: "session" });
    try {
      const entries = await sessionListFiles(sessionId, path);
      if (requestSeq !== sessionFileBrowserRequestSeq) return;
      mirrorFileBrowserIntent("fileBrowser.loadSucceeded", {
        pane: "session",
        path,
        entries,
      });
    } catch (err) {
      if (requestSeq !== sessionFileBrowserRequestSeq) return;
      const message = errorMessage(err);
      mirrorFileBrowserIntent("fileBrowser.loadFailed", { pane: "session", error: message });
    }
  },

  refreshSession: async () => {
    const { sessionFileBrowserId } = get();
    if (!sessionFileBrowserId) return;
    const sessionCurrentPath = currentFileBrowsersView().session.path;
    const requestSeq = ++sessionFileBrowserRequestSeq;
    mirrorFileBrowserIntent("fileBrowser.loadStarted", { pane: "session" });
    try {
      const entries = await sessionListFiles(sessionFileBrowserId, sessionCurrentPath);
      if (requestSeq !== sessionFileBrowserRequestSeq) return;
      mirrorFileBrowserIntent("fileBrowser.loadSucceeded", {
        pane: "session",
        path: sessionCurrentPath,
        entries,
      });
    } catch (err) {
      if (requestSeq !== sessionFileBrowserRequestSeq) return;
      const message = errorMessage(err);
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
