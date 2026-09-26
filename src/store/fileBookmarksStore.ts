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
  removeFileBookmark,
  renameFileBookmark,
} from "@/services/fileBookmarksApi";
import type { FileBookmark } from "@/types/fileBookmark";
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
}

/** The bookmarks of one scope, in the order they were added. */
export function bookmarksForScope(
  bookmarks: FileBookmark[],
  scope: string | null
): FileBookmark[] {
  if (!scope) return [];
  return bookmarks.filter((b) => b.scope === scope);
}

export const useFileBookmarksStore = create<FileBookmarksState>((set) => ({
  bookmarks: [],
  loaded: false,

  load: async () => {
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
}));
