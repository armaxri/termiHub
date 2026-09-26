//! Bounded, persisted file-browser bookmarks (PROD-007, #3558).
//!
//! The frontend adds, renames and removes bookmarks through the
//! `*_file_browser_bookmark*` commands; this manager owns the store, validates
//! and bounds every record, and persists it. The bounds are enforced here — not
//! trusted from the caller — so a buggy caller cannot grow the file without
//! limit:
//!
//! * [`MAX_BOOKMARKS_PER_SCOPE`] — bookmarks one connection scope can hold.
//! * [`MAX_BOOKMARKS_TOTAL`] — bookmarks across every scope.
//! * [`MAX_PATH_CHARS`], [`MAX_NAME_CHARS`], [`MAX_SCOPE_CHARS`] — field sizes.

use std::sync::Mutex;

use anyhow::{Context, Result};
use chrono::Utc;
use tauri::AppHandle;

use super::bookmarks::{FileBookmark, FileBookmarkStore};
use super::bookmarks_storage::FileBookmarkStorage;
use crate::connection::recovery::RecoveryWarning;
use crate::utils::errors::TerminalError;

/// The most bookmarks a single connection scope can hold.
pub const MAX_BOOKMARKS_PER_SCOPE: usize = 200;
/// The most bookmarks across every scope.
pub const MAX_BOOKMARKS_TOTAL: usize = 5_000;
/// The longest bookmarked path, in characters.
pub const MAX_PATH_CHARS: usize = 4_096;
/// The longest display name, in characters (longer names are shortened).
pub const MAX_NAME_CHARS: usize = 200;
/// The longest scope key, in characters.
pub const MAX_SCOPE_CHARS: usize = 512;

/// Central file-browser bookmark manager. Mirrors
/// [`crate::network::tool_history_manager::NetworkToolHistoryManager`].
pub struct FileBookmarkManager {
    store: Mutex<FileBookmarkStore>,
    storage: FileBookmarkStorage,
    recovery_warnings: Mutex<Vec<RecoveryWarning>>,
}

impl FileBookmarkManager {
    /// Initialize from disk, with recovery on corruption.
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        let storage = FileBookmarkStorage::new(app_handle)
            .context("Failed to initialize file bookmark storage")?;
        Self::with_storage(storage)
    }

    fn with_storage(storage: FileBookmarkStorage) -> Result<Self> {
        let result = storage
            .load_with_recovery()
            .context("Failed to load file bookmarks")?;
        Ok(Self {
            store: Mutex::new(result.data),
            storage,
            recovery_warnings: Mutex::new(result.warnings),
        })
    }

    /// Take ownership of any recovery warnings (only the first call returns them).
    pub fn take_recovery_warnings(&self) -> Vec<RecoveryWarning> {
        self.recovery_warnings
            .lock()
            .map(|mut w| std::mem::take(&mut *w))
            .unwrap_or_default()
    }

    /// Every bookmark in the order it was added — all scopes, or one `scope`.
    pub fn list(&self, scope: Option<&str>) -> Result<Vec<FileBookmark>, TerminalError> {
        let store = self.lock()?;
        Ok(store
            .bookmarks
            .iter()
            .filter(|b| scope.is_none_or(|s| b.scope == s))
            .cloned()
            .collect())
    }

    /// Bookmark `path` in `scope`. `name` defaults to the path's last segment.
    /// Bookmarking a path the scope already holds returns the existing
    /// bookmark unchanged (adding is idempotent).
    pub fn add(
        &self,
        scope: &str,
        path: &str,
        name: Option<&str>,
    ) -> Result<FileBookmark, TerminalError> {
        let scope = scope.trim();
        let path = path.trim();
        if scope.is_empty() {
            return Err(invalid("bookmark scope is empty"));
        }
        if scope.chars().count() > MAX_SCOPE_CHARS {
            return Err(invalid("bookmark scope is too long"));
        }
        if path.is_empty() {
            return Err(invalid("bookmark path is empty"));
        }
        if path.chars().count() > MAX_PATH_CHARS {
            return Err(invalid(&format!(
                "bookmark path is too long (max {MAX_PATH_CHARS} characters)"
            )));
        }

        let mut store = self.lock()?;
        if let Some(existing) = store
            .bookmarks
            .iter()
            .find(|b| b.scope == scope && b.path == path)
        {
            return Ok(existing.clone());
        }
        let in_scope = store.bookmarks.iter().filter(|b| b.scope == scope).count();
        if in_scope >= MAX_BOOKMARKS_PER_SCOPE {
            return Err(invalid(&format!(
                "this connection already has {MAX_BOOKMARKS_PER_SCOPE} bookmarks; remove one first"
            )));
        }
        if store.bookmarks.len() >= MAX_BOOKMARKS_TOTAL {
            return Err(invalid(&format!(
                "there are already {MAX_BOOKMARKS_TOTAL} bookmarks; remove some first"
            )));
        }

        let name = match name.map(str::trim).filter(|n| !n.is_empty()) {
            Some(n) => shorten(n),
            None => shorten(default_name(path)),
        };
        let bookmark = FileBookmark {
            id: uuid::Uuid::new_v4().to_string(),
            scope: scope.to_string(),
            path: path.to_string(),
            name,
            created_at: Utc::now().to_rfc3339(),
        };
        store.bookmarks.push(bookmark.clone());
        self.persist(&store)?;
        Ok(bookmark)
    }

    /// Rename a bookmark. An empty name is rejected; a long one is shortened.
    pub fn rename(&self, id: &str, name: &str) -> Result<FileBookmark, TerminalError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(invalid("bookmark name is empty"));
        }
        let mut store = self.lock()?;
        let Some(bookmark) = store.bookmarks.iter_mut().find(|b| b.id == id) else {
            return Err(TerminalError::NotFound(format!("bookmark {id}")));
        };
        bookmark.name = shorten(name);
        let renamed = bookmark.clone();
        self.persist(&store)?;
        Ok(renamed)
    }

    /// Remove a bookmark by id. Removing an unknown id is a no-op.
    pub fn remove(&self, id: &str) -> Result<(), TerminalError> {
        let mut store = self.lock()?;
        let before = store.bookmarks.len();
        store.bookmarks.retain(|b| b.id != id);
        if store.bookmarks.len() != before {
            self.persist(&store)?;
        }
        Ok(())
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, FileBookmarkStore>, TerminalError> {
        self.store
            .lock()
            .map_err(|e| TerminalError::InternalError(e.to_string()))
    }

    fn persist(&self, store: &FileBookmarkStore) -> Result<(), TerminalError> {
        self.storage
            .save(store)
            .map_err(|e| TerminalError::InternalError(e.to_string()))
    }
}

fn invalid(message: &str) -> TerminalError {
    TerminalError::InvalidParams(message.to_string())
}

/// The last segment of a `/`- or `\`-separated path; the path itself for a
/// root (`/`, `C:\`, `~`).
fn default_name(path: &str) -> &str {
    let trimmed = path.trim_end_matches(['/', '\\']);
    match trimmed.rsplit(['/', '\\']).next() {
        Some(last) if !last.is_empty() && !last.ends_with(':') => last,
        _ => path,
    }
}

/// Shorten `text` to at most [`MAX_NAME_CHARS`] characters.
fn shorten(text: &str) -> String {
    text.chars().take(MAX_NAME_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn manager(dir: &TempDir) -> FileBookmarkManager {
        FileBookmarkManager::with_storage(FileBookmarkStorage::new_test(dir.path())).unwrap()
    }

    #[test]
    fn add_defaults_the_name_to_the_last_segment() {
        let dir = TempDir::new().unwrap();
        let m = manager(&dir);
        assert_eq!(m.add("local", "/var/log/", None).unwrap().name, "log");
        assert_eq!(m.add("local", "C:\\Users\\me", None).unwrap().name, "me");
        assert_eq!(m.add("local", "/", None).unwrap().name, "/");
        assert_eq!(m.add("local", "C:\\", None).unwrap().name, "C:\\");
        assert_eq!(m.add("local", "/srv", Some("  Web  ")).unwrap().name, "Web");
    }

    #[test]
    fn bookmarks_persist_across_a_restart() {
        let dir = TempDir::new().unwrap();
        let added = manager(&dir)
            .add("connection:c1", "/home/ops", None)
            .unwrap();
        let reloaded = manager(&dir);
        assert_eq!(reloaded.list(None).unwrap(), vec![added]);
    }

    #[test]
    fn list_filters_by_scope() {
        let dir = TempDir::new().unwrap();
        let m = manager(&dir);
        m.add("connection:a", "/a", None).unwrap();
        m.add("connection:b", "/b", None).unwrap();
        let only_a = m.list(Some("connection:a")).unwrap();
        assert_eq!(only_a.len(), 1);
        assert_eq!(only_a[0].path, "/a");
        assert_eq!(m.list(None).unwrap().len(), 2);
    }

    #[test]
    fn adding_the_same_path_twice_is_idempotent() {
        let dir = TempDir::new().unwrap();
        let m = manager(&dir);
        let first = m.add("local", "/tmp", None).unwrap();
        let second = m.add("local", " /tmp ", Some("Other")).unwrap();
        assert_eq!(first, second);
        assert_eq!(m.list(None).unwrap().len(), 1);
        // The same path in another scope is a separate bookmark.
        m.add("connection:c", "/tmp", None).unwrap();
        assert_eq!(m.list(None).unwrap().len(), 2);
    }

    #[test]
    fn rename_and_remove_persist() {
        let dir = TempDir::new().unwrap();
        let m = manager(&dir);
        let b = m.add("local", "/tmp", None).unwrap();
        let keep = m.add("local", "/srv", None).unwrap();
        assert_eq!(m.rename(&b.id, " Scratch ").unwrap().name, "Scratch");
        m.remove(&keep.id).unwrap();

        let reloaded = manager(&dir).list(None).unwrap();
        assert_eq!(reloaded.len(), 1);
        assert_eq!(reloaded[0].name, "Scratch");
    }

    #[test]
    fn invalid_input_is_rejected() {
        let dir = TempDir::new().unwrap();
        let m = manager(&dir);
        assert!(m.add("", "/tmp", None).is_err());
        assert!(m.add("local", "  ", None).is_err());
        assert!(m
            .add("local", &"a".repeat(MAX_PATH_CHARS + 1), None)
            .is_err());
        assert!(m.add(&"s".repeat(MAX_SCOPE_CHARS + 1), "/", None).is_err());
        let b = m.add("local", "/tmp", None).unwrap();
        assert!(m.rename(&b.id, "   ").is_err());
        assert!(matches!(
            m.rename("missing", "x"),
            Err(TerminalError::NotFound(_))
        ));
        // Removing an unknown id is a no-op.
        m.remove("missing").unwrap();
    }

    #[test]
    fn long_names_are_shortened() {
        let dir = TempDir::new().unwrap();
        let m = manager(&dir);
        let b = m.add("local", "/tmp", Some(&"n".repeat(500))).unwrap();
        assert_eq!(b.name.chars().count(), MAX_NAME_CHARS);
    }

    #[test]
    fn a_scope_is_capped() {
        let dir = TempDir::new().unwrap();
        let m = manager(&dir);
        for i in 0..MAX_BOOKMARKS_PER_SCOPE {
            m.add("local", &format!("/d{i}"), None).unwrap();
        }
        assert!(m.add("local", "/one-too-many", None).is_err());
        // Another scope is unaffected.
        m.add("connection:c", "/fine", None).unwrap();
    }
}
