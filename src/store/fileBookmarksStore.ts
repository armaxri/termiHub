/**
 * UI mirror of the file-browser bookmarks (PROD-007, #3558).
 *
 * The backend owns the persisted, bounded store (`file-browser-bookmarks.json`);
 * this Zustand store only caches the list and routes add / rename / remove
 * through the backend commands. Mutations reject on failure so the caller can
 * surface the error; the cache only changes once the backend confirmed.
 */

import { create } from "zustand";
import {
  addFileBookmark,
  listFileBookmarks,
  onFileBookmarksRekeyed,
  removeFileBookmark,
  renameFileBookmark,
} from "@/services/fileBookmarksApi";
import type { FileBookmark, FileBookmarkScopeRekey } from "@/types/fileBookmark";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";

interface FileBookmarksState {
  /** Every bookmark across all scopes, in the order it was added. */
  bookmarks: FileBookmark[];
  /** True once the list has been fetched from the backend. */
  loaded: boolean;
  /** Fetch the full list from the backend (never throws). */
  load: () => Promise<void>;
  /** Bookmark `path` in `scope`; resolves to the stored bookmark. */
  add: (scope: string, path: string, name?: string) => Promise<FileBookmark>;
  /** Rename a bookmark. */
  rename: (id: string, name: string) => Promise<void>;
  /** Remove a bookmark. */
  remove: (id: string) => Promise<void>;
  /**
   * Drop every cached bookmark whose scope matches — the UI side of the
   * backend's prune when a saved connection or agent is deleted (#3562).
   */
  forgetScopes: (matches: (scope: string) => boolean) => void;
  /**
   * Move cached bookmarks between scopes — the UI side of the backend's
   * re-key when a saved connection's id changes (#3569).
   */
  rekeyScopes: (renames: readonly FileBookmarkScopeRekey[]) => void;
}

/** The bookmarks of one scope, in the order they were added. */
export function bookmarksForScope(bookmarks: FileBookmark[], scope: string | null): FileBookmark[] {
  if (!scope) return [];
  return bookmarks.filter((b) => b.scope === scope);
}

/**
 * `bookmarks` with every scope in `renames` moved to its target, all at once,
 * keeping the earliest-added bookmark of a path a target already holds. The
 * same rule as the backend `rekey_scopes`, so the cache matches the store.
 */
export function rekeyBookmarkScopes(
  bookmarks: readonly FileBookmark[],
  renames: readonly FileBookmarkScopeRekey[]
): FileBookmark[] {
  const targets = new Map(
    renames.filter((r) => r.from && r.to && r.from !== r.to).map((r) => [r.from, r.to])
  );
  const seen = new Set<string>();
  const result: FileBookmark[] = [];
  for (const bookmark of bookmarks) {
    const to = targets.get(bookmark.scope);
    const next = to === undefined ? bookmark : { ...bookmark, scope: to };
    const key = JSON.stringify([next.scope, next.path]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(next);
  }
  return result;
}

/** Whether this window already follows the backend's re-keys. */
let followingRekeys = false;

/** Follow the backend's re-keys from now on (once per window). */
function followRekeys(apply: (renames: FileBookmarkScopeRekey[]) => void): void {
  if (followingRekeys) return;
  followingRekeys = true;
  const failed = (err: unknown): void => {
    followingRekeys = false;
    frontendLog("file_bookmarks", `Failed to follow bookmark re-keys: ${errorMessage(err)}`);
  };
  try {
    onFileBookmarksRekeyed(apply).catch(failed);
  } catch (err) {
    failed(err);
  }
}

export const useFileBookmarksStore = create<FileBookmarksState>((set, get) => ({
  bookmarks: [],
  loaded: false,

  load: async () => {
    followRekeys((renames) => get().rekeyScopes(renames));
    try {
      const bookmarks = await listFileBookmarks();
      set({ bookmarks: Array.isArray(bookmarks) ? bookmarks : [], loaded: true });
    } catch (err) {
      frontendLog("file_bookmarks", `Failed to load bookmarks: ${errorMessage(err)}`);
      set({ loaded: true });
    }
  },

  add: async (scope, path, name) => {
    const stored = await addFileBookmark(scope, path, name);
    set((s) =>
      s.bookmarks.some((b) => b.id === stored.id) ? s : { bookmarks: [...s.bookmarks, stored] }
    );
    return stored;
  },

  rename: async (id, name) => {
    const stored = await renameFileBookmark(id, name);
    set((s) => ({ bookmarks: s.bookmarks.map((b) => (b.id === id ? stored : b)) }));
  },

  remove: async (id) => {
    await removeFileBookmark(id);
    set((s) => ({ bookmarks: s.bookmarks.filter((b) => b.id !== id) }));
  },

  forgetScopes: (matches) => {
    set((s) =>
      s.bookmarks.some((b) => matches(b.scope))
        ? { bookmarks: s.bookmarks.filter((b) => !matches(b.scope)) }
        : s
    );
  },

  rekeyScopes: (renames) => {
    const moves = new Set(renames.map((r) => r.from));
    set((s) =>
      s.bookmarks.some((b) => moves.has(b.scope))
        ? { bookmarks: rekeyBookmarkScopes(s.bookmarks, renames) }
        : s
    );
  },
}));
