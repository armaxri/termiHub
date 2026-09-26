//! Tauri commands for the persisted file-browser bookmarks (PROD-007, #3558).

use tauri::State;

use crate::files::bookmarks::FileBookmark;
use crate::files::bookmarks_manager::FileBookmarkManager;
use crate::utils::errors::TerminalError;

/// Every bookmark in the order it was added — all scopes, or one `scope`.
#[tauri::command]
pub fn list_file_browser_bookmarks(
    scope: Option<String>,
    manager: State<'_, FileBookmarkManager>,
) -> Result<Vec<FileBookmark>, TerminalError> {
    manager.list(scope.as_deref())
}

/// Bookmark `path` in `scope`; `name` defaults to the path's last segment.
/// Bookmarking an already-bookmarked path returns the existing bookmark.
#[tauri::command]
pub fn add_file_browser_bookmark(
    scope: String,
    path: String,
    name: Option<String>,
    manager: State<'_, FileBookmarkManager>,
) -> Result<FileBookmark, TerminalError> {
    manager.add(&scope, &path, name.as_deref())
}

/// Rename a bookmark; returns it as stored.
#[tauri::command]
pub fn rename_file_browser_bookmark(
    id: String,
    name: String,
    manager: State<'_, FileBookmarkManager>,
) -> Result<FileBookmark, TerminalError> {
    manager.rename(&id, &name)
}

/// Remove a bookmark. Removing an unknown id is a no-op.
#[tauri::command]
pub fn remove_file_browser_bookmark(
    id: String,
    manager: State<'_, FileBookmarkManager>,
) -> Result<(), TerminalError> {
    manager.remove(&id)
}
