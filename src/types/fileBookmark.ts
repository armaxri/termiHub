/**
 * A directory bookmarked in the file browser (PROD-007, #3558). Mirrors the
 * backend `FileBookmark` in `src-tauri/src/files/bookmarks.rs`.
 */
export interface FileBookmark {
  /** Unique identifier. */
  id: string;
  /**
   * The connection scope the bookmark belongs to — see
   * `fileBookmarkScope` (`local`, `connection:<id>`, `agent:…`, `host:…`).
   */
  scope: string;
  /** The bookmarked directory, exactly as the file browser navigates to it. */
  path: string;
  /** Display name (the directory's base name unless renamed). */
  name: string;
  /** RFC 3339 timestamp of when the bookmark was added. */
  createdAt: string;
}
