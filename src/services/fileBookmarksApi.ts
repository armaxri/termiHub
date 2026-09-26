/**
 * Tauri command wrappers for the file-browser bookmarks (PROD-007, #3558).
 *
 * The backend owns the store (`file-browser-bookmarks.json`) and validates and
 * bounds every record, so these are thin wrappers.
 */

import { invoke } from "@tauri-apps/api/core";
import type { FileBookmark } from "@/types/fileBookmark";

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
