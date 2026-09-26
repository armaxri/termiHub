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

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use anyhow::{Context, Result};
use chrono::Utc;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use super::bookmarks::{FileBookmark, FileBookmarkStore};
use super::bookmarks_storage::FileBookmarkStorage;
use crate::connection::manager::ConnectionIdChange;
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

/// The bookmark scope of a saved connection. Mirrors the frontend's
/// `fileBookmarkScope` (`src/utils/fileBookmarkScope.ts`), which keys a tab
/// opened from a saved connection — in the main store or an external file —
/// as `connection:<id>`.
pub fn connection_scope(connection_id: &str) -> String {
    format!("connection:{connection_id}")
}

/// The prefix shared by every bookmark scope of a saved remote agent's
/// sessions (`agent:<agent id>:<session type>`, see `fileBookmarkScope`).
pub fn agent_scope_prefix(agent_id: &str) -> String {
    format!("agent:{agent_id}:")
}

/// Event telling every window that bookmarks moved to another scope (#3569);
/// the payload is a list of [`ScopeRekey`]s for the UI cache to mirror.
pub const FILE_BOOKMARKS_REKEYED_EVENT: &str = "file-bookmarks-rekeyed";

/// Bookmarks in scope `from` moved to scope `to`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScopeRekey {
    pub from: String,
    pub to: String,
}

/// Make saved connections' bookmarks follow their id changes (#3569): re-key
/// the bookmarks of every renamed or moved connection in `changes` (already
/// persisted), then tell every window's cache. Called from the connection
/// manager's id-change listener that the boot phase registers (see
/// `crate::boot::connection_id_changes`); without a managed
/// [`FileBookmarkManager`] this is a no-op.
pub fn follow_connection_renames<R: Runtime>(app: &AppHandle<R>, changes: &[ConnectionIdChange]) {
    let Some(bookmarks) = app.try_state::<FileBookmarkManager>() else {
        return;
    };
    let moved = bookmarks.follow_connection_id_changes(changes);
    if moved.is_empty() {
        return;
    }
    let payload: Vec<ScopeRekey> = moved
        .into_iter()
        .map(|(from, to)| ScopeRekey { from, to })
        .collect();
    if let Err(e) = app.emit(FILE_BOOKMARKS_REKEYED_EVENT, payload) {
        tracing::warn!("Failed to announce re-keyed bookmarks: {e}");
    }
}

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

    /// A manager backed by a file in `dir`. Test-only; production uses `new()`.
    #[cfg(test)]
    pub(crate) fn new_for_test(dir: &std::path::Path) -> Result<Self> {
        Self::with_storage(FileBookmarkStorage::new_test(dir))
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

    /// Remove every bookmark in `scope` (#3562), e.g. when the saved
    /// connection it belongs to is deleted. Returns how many were removed;
    /// removing an empty or unknown scope is a no-op and does not write.
    pub fn remove_scope(&self, scope: &str) -> Result<usize, TerminalError> {
        self.remove_where(|b| b.scope == scope)
    }

    /// Remove every bookmark whose scope starts with `prefix` (#3562), e.g.
    /// every session type of a deleted remote agent. An empty prefix is
    /// rejected so a caller bug can never wipe every bookmark.
    pub fn remove_scopes_with_prefix(&self, prefix: &str) -> Result<usize, TerminalError> {
        if prefix.is_empty() {
            return Err(invalid("bookmark scope prefix is empty"));
        }
        self.remove_where(|b| b.scope.starts_with(prefix))
    }

    /// Drop a deleted saved connection's bookmarks (#3562). Best-effort: the
    /// connection is already gone, so a failure is logged, never surfaced.
    /// Covers main-store and external-file connections alike — both are keyed
    /// `connection:<id>`.
    pub fn prune_deleted_connection(&self, connection_id: &str) {
        match self.remove_scope(&connection_scope(connection_id)) {
            Ok(0) => {}
            Ok(n) => tracing::info!(
                connection_id,
                removed = n,
                "Removed deleted connection's bookmarks"
            ),
            Err(e) => tracing::warn!(
                connection_id,
                "Failed to remove deleted connection's bookmarks: {e}"
            ),
        }
    }

    /// Drop a deleted remote agent's bookmarks — every session type (#3562).
    /// Best-effort, like [`Self::prune_deleted_connection`].
    pub fn prune_deleted_agent(&self, agent_id: &str) {
        if agent_id.is_empty() {
            return;
        }
        match self.remove_scopes_with_prefix(&agent_scope_prefix(agent_id)) {
            Ok(0) => {}
            Ok(n) => tracing::info!(agent_id, removed = n, "Removed deleted agent's bookmarks"),
            Err(e) => tracing::warn!(agent_id, "Failed to remove deleted agent's bookmarks: {e}"),
        }
    }

    /// Move bookmarks between scopes (#3569): every bookmark in a `from` scope
    /// moves to its `to` scope. All renames apply at once, so a swap
    /// (`a → b`, `b → a`) or a chain (`a → b`, `b → c`) moves each list exactly
    /// one step. A path the target scope already holds is kept once — the
    /// earliest-added bookmark wins — so re-keying is idempotent and merging
    /// never duplicates. Returns the `(from, to)` pairs whose `from` scope held
    /// bookmarks, in `renames` order; nothing is written when none did.
    ///
    /// A merge may leave a scope above [`MAX_BOOKMARKS_PER_SCOPE`]: dropping a
    /// user's bookmarks to honour the cap would be worse than a list that is
    /// briefly too long (adding is refused until it shrinks again), and the
    /// total never grows.
    pub fn rekey_scopes(
        &self,
        renames: &[(String, String)],
    ) -> Result<Vec<(String, String)>, TerminalError> {
        let map: HashMap<&str, &str> = renames
            .iter()
            .filter(|(from, to)| from != to && !from.is_empty() && !to.is_empty())
            .map(|(from, to)| (from.as_str(), to.as_str()))
            .collect();
        if map.is_empty() {
            return Ok(Vec::new());
        }

        let mut store = self.lock()?;
        let mut moved_from: HashSet<String> = HashSet::new();
        for bookmark in store.bookmarks.iter_mut() {
            if let Some(to) = map.get(bookmark.scope.as_str()) {
                moved_from.insert(std::mem::replace(&mut bookmark.scope, (*to).to_string()));
            }
        }
        if moved_from.is_empty() {
            return Ok(Vec::new());
        }
        let mut seen = HashSet::new();
        store
            .bookmarks
            .retain(|b| seen.insert((b.scope.clone(), b.path.clone())));
        self.persist(&store)?;

        let mut moved = Vec::new();
        for (from, to) in renames {
            if moved_from.remove(from) {
                moved.push((from.clone(), to.clone()));
            }
        }
        Ok(moved)
    }

    /// Carry saved connections' bookmarks over to their new ids (#3569): a
    /// rename or move of a connection — or of a folder above it — recomputes
    /// its path-based id. Best-effort, like the delete prune: the connection
    /// change is already durable, so a failure is logged, never surfaced.
    /// Returns the `(from, to)` scope pairs whose bookmarks moved, for the UI
    /// cache to mirror (empty when nothing moved or on failure).
    pub fn follow_connection_id_changes(
        &self,
        changes: &[ConnectionIdChange],
    ) -> Vec<(String, String)> {
        let renames: Vec<(String, String)> = changes
            .iter()
            .map(|c| (connection_scope(&c.old_id), connection_scope(&c.new_id)))
            .collect();
        match self.rekey_scopes(&renames) {
            Ok(moved) => {
                if !moved.is_empty() {
                    tracing::info!(
                        scopes = moved.len(),
                        "Moved renamed connections' bookmarks to their new ids"
                    );
                }
                moved
            }
            Err(e) => {
                tracing::warn!("Failed to move renamed connections' bookmarks: {e}");
                Vec::new()
            }
        }
    }

    fn remove_where(&self, doomed: impl Fn(&FileBookmark) -> bool) -> Result<usize, TerminalError> {
        let mut store = self.lock()?;
        let before = store.bookmarks.len();
        store.bookmarks.retain(|b| !doomed(b));
        let removed = before - store.bookmarks.len();
        if removed > 0 {
            self.persist(&store)?;
        }
        Ok(removed)
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
    fn remove_scope_drops_only_that_scope_and_persists() {
        let dir = TempDir::new().unwrap();
        let m = manager(&dir);
        let scope = connection_scope("c1");
        m.add(&scope, "/a", None).unwrap();
        m.add(&scope, "/b", None).unwrap();
        m.add("connection:c10", "/c", None).unwrap();
        m.add("local", "/d", None).unwrap();

        assert_eq!(m.remove_scope(&scope).unwrap(), 2);
        // Idempotent: a second prune removes nothing.
        assert_eq!(m.remove_scope(&scope).unwrap(), 0);

        let reloaded = manager(&dir).list(None).unwrap();
        let scopes: Vec<&str> = reloaded.iter().map(|b| b.scope.as_str()).collect();
        assert_eq!(scopes, vec!["connection:c10", "local"]);
    }

    #[test]
    fn remove_scopes_with_prefix_drops_every_agent_session_type() {
        let dir = TempDir::new().unwrap();
        let m = manager(&dir);
        let prefix = agent_scope_prefix("ag1");
        m.add("agent:ag1:local", "/a", None).unwrap();
        m.add("agent:ag1:docker", "/b", None).unwrap();
        m.add("agent:ag10:local", "/c", None).unwrap();

        assert_eq!(m.remove_scopes_with_prefix(&prefix).unwrap(), 2);
        assert_eq!(m.remove_scopes_with_prefix(&prefix).unwrap(), 0);
        let reloaded = manager(&dir).list(None).unwrap();
        assert_eq!(reloaded.len(), 1);
        assert_eq!(reloaded[0].scope, "agent:ag10:local");
    }

    #[test]
    fn pruning_a_deleted_connection_or_agent_is_idempotent() {
        let dir = TempDir::new().unwrap();
        let m = manager(&dir);
        m.add("connection:c1", "/a", None).unwrap();
        m.add("agent:ag1:ssh", "/b", None).unwrap();
        m.add("local", "/c", None).unwrap();
        for _ in 0..2 {
            m.prune_deleted_connection("c1");
            m.prune_deleted_agent("ag1");
        }
        // An empty agent id must not match every `agent:` scope.
        m.prune_deleted_agent("");
        let left = manager(&dir).list(None).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].scope, "local");
    }

    fn pair(from: &str, to: &str) -> (String, String) {
        (from.to_string(), to.to_string())
    }

    fn scopes_and_paths(m: &FileBookmarkManager) -> Vec<(String, String)> {
        m.list(None)
            .unwrap()
            .into_iter()
            .map(|b| (b.scope, b.path))
            .collect()
    }

    #[test]
    fn rekey_moves_a_scope_persists_and_is_idempotent() {
        let dir = TempDir::new().unwrap();
        let m = manager(&dir);
        let kept = m.add("connection:a", "/srv", Some("Web")).unwrap();
        m.add("connection:ab", "/x", None).unwrap();

        let renames = [pair("connection:a", "connection:b")];
        assert_eq!(m.rekey_scopes(&renames).unwrap(), renames.to_vec());
        // Nothing left to move the second time.
        assert!(m.rekey_scopes(&renames).unwrap().is_empty());

        let reloaded = manager(&dir);
        assert_eq!(
            scopes_and_paths(&reloaded),
            vec![pair("connection:b", "/srv"), pair("connection:ab", "/x")]
        );
        // The bookmark itself — id, name — is unchanged.
        let moved = &reloaded.list(Some("connection:b")).unwrap()[0];
        assert_eq!(
            (moved.id.as_str(), moved.name.as_str()),
            (kept.id.as_str(), "Web")
        );
    }

    #[test]
    fn rekey_merges_into_an_existing_scope_without_duplicates() {
        let dir = TempDir::new().unwrap();
        let m = manager(&dir);
        m.add("connection:old", "/srv", Some("Old name")).unwrap();
        m.add("connection:new", "/srv", Some("New name")).unwrap();
        m.add("connection:old", "/var", None).unwrap();

        m.rekey_scopes(&[pair("connection:old", "connection:new")])
            .unwrap();
        let left = manager(&dir).list(None).unwrap();
        let summary: Vec<(&str, &str, &str)> = left
            .iter()
            .map(|b| (b.scope.as_str(), b.path.as_str(), b.name.as_str()))
            .collect();
        // The earliest-added bookmark of a path wins.
        assert_eq!(
            summary,
            vec![
                ("connection:new", "/srv", "Old name"),
                ("connection:new", "/var", "var")
            ]
        );
    }

    #[test]
    fn rekey_applies_swaps_and_chains_in_one_step() {
        let dir = TempDir::new().unwrap();
        let m = manager(&dir);
        m.add("connection:a", "/a", None).unwrap();
        m.add("connection:b", "/b", None).unwrap();
        m.add("connection:c", "/c", None).unwrap();

        m.rekey_scopes(&[
            pair("connection:a", "connection:b"),
            pair("connection:b", "connection:a"),
            pair("connection:c", "connection:d"),
            pair("connection:d", "connection:e"),
        ])
        .unwrap();
        assert_eq!(
            scopes_and_paths(&m),
            vec![
                pair("connection:b", "/a"),
                pair("connection:a", "/b"),
                pair("connection:d", "/c")
            ]
        );
    }

    #[test]
    fn following_connection_id_changes_moves_their_bookmarks() {
        let dir = TempDir::new().unwrap();
        let m = manager(&dir);
        m.add("connection:Work/x", "/srv", None).unwrap();
        m.add("local", "/tmp", None).unwrap();

        let moved = m.follow_connection_id_changes(&[
            ConnectionIdChange::new("Work/x", "Job/x"),
            ConnectionIdChange::new("Work/y", "Job/y"),
        ]);
        // Only scopes that held bookmarks are reported.
        assert_eq!(moved, vec![pair("connection:Work/x", "connection:Job/x")]);
        assert_eq!(
            scopes_and_paths(&manager(&dir)),
            vec![pair("connection:Job/x", "/srv"), pair("local", "/tmp")]
        );
        assert!(m
            .follow_connection_id_changes(&[ConnectionIdChange::new("Work/x", "Job/x")])
            .is_empty());
    }

    #[test]
    fn an_empty_prefix_is_rejected() {
        let dir = TempDir::new().unwrap();
        let m = manager(&dir);
        m.add("local", "/a", None).unwrap();
        assert!(m.remove_scopes_with_prefix("").is_err());
        assert_eq!(m.list(None).unwrap().len(), 1);
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
