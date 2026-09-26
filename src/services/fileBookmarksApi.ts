/**
 * Tauri command wrappers for the file-browser bookmarks (PROD-007, #3558).
 *
 * The backend owns the store (`file-browser-bookmarks.json`) and validates and
 * bounds every record, so these are thin wrappers.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { FileBookmark, FileBookmarkScopeRekey } from "@/types/fileBookmark";

/** Emitted by the backend after it moved bookmarks to another scope (#3569). */
export const FILE_BOOKMARKS_REKEYED_EVENT = "file-bookmarks-rekeyed";

/** Every bookmark in the order it was added — all scopes, or one `scope`. */
export async function listFileBookmarks(scope?: string): Promise<FileBookmark[]> {
  return await invoke<FileBookmark[]>("list_file_browser_bookmarks", { scope: scope ?? null });
}

/**
 * Bookmark `path` in `scope` (`name` defaults to the last path segment).
 * Resolves to the stored bookmark — the existing one when already bookmarked.
 */
export async function addFileBookmark(
  scope: string,
  path: string,
  name?: string
): Promise<FileBookmark> {
  return await invoke<FileBookmark>("add_file_browser_bookmark", {
    scope,
    path,
    name: name ?? null,
  });
}

/** Rename a bookmark; resolves to it as stored. */
export async function renameFileBookmark(id: string, name: string): Promise<FileBookmark> {
  return await invoke<FileBookmark>("rename_file_browser_bookmark", { id, name });
}

/** Remove a bookmark. */
export async function removeFileBookmark(id: string): Promise<void> {
  await invoke("remove_file_browser_bookmark", { id });
}

/**
 * Subscribe to the backend moving bookmarks between scopes — it re-keys a
 * saved connection's bookmarks when the connection's id changes (#3569).
 */
export async function onFileBookmarksRekeyed(
  callback: (renames: FileBookmarkScopeRekey[]) => void
): Promise<UnlistenFn> {
  return await listen<FileBookmarkScopeRekey[]>(FILE_BOOKMARKS_REKEYED_EVENT, (event) =>
    callback(event.payload)
  );
}
