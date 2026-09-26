//! Saved-connection id changes (#3569).
//!
//! A saved connection's id is its path in the connection tree (`Folder/Name`),
//! recomputed from the folder chain and the name every time the tree is loaded.
//! Renaming or moving a connection — or renaming, moving or deleting a folder
//! above it — therefore changes its id. Data keyed by the id outside the tree
//! (file-browser bookmarks, `connection:<id>`) must follow the change, so the
//! [`ConnectionManager`](super::manager::ConnectionManager) reports every change
//! it persists as a list of [`ConnectionIdChange`]s to a listener.

use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;

use super::config::{ConnectionFolder, SavedConnection};
use super::tree::{compute_connection_id, compute_folder_id};

/// One saved connection's id changed from `old_id` to `new_id`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionIdChange {
    pub old_id: String,
    pub new_id: String,
}

impl ConnectionIdChange {
    pub fn new(old_id: impl Into<String>, new_id: impl Into<String>) -> Self {
        Self {
            old_id: old_id.into(),
            new_id: new_id.into(),
        }
    }
}

/// Called with the id changes of one persisted operation, right after it was
/// written. Never called with an empty list.
pub type ConnectionIdChangeListener = Arc<dyn Fn(&[ConnectionIdChange]) + Send + Sync>;

/// Deepest folder nesting followed when resolving a folder path; anything
/// deeper is treated as a cycle.
const MAX_FOLDER_DEPTH: usize = 256;

/// The id `connection` gets when the tree is written and loaded again — its
/// folder chain's names plus its own name. `None` when the connection would not
/// be written at all (its folder, or a folder above it, is missing).
pub fn reloaded_connection_id(
    connection: &SavedConnection,
    folders: &[ConnectionFolder],
) -> Option<String> {
    let folder_path = match connection.folder_id.as_deref() {
        None => None,
        Some(folder_id) => Some(reloaded_folder_id(folder_id, folders, 0)?),
    };
    Some(compute_connection_id(
        folder_path.as_deref(),
        &connection.name,
    ))
}

fn reloaded_folder_id(
    folder_id: &str,
    folders: &[ConnectionFolder],
    depth: usize,
) -> Option<String> {
    if depth > MAX_FOLDER_DEPTH {
        return None;
    }
    let folder = folders.iter().find(|f| f.id == folder_id)?;
    let parent_path = match folder.parent_id.as_deref() {
        None => None,
        Some(parent_id) => Some(reloaded_folder_id(parent_id, folders, depth + 1)?),
    };
    Some(compute_folder_id(parent_path.as_deref(), &folder.name))
}

/// The id changes between `before` — the connections' ids before an operation,
/// by position — and `connections` as the operation leaves them. Only the
/// positions present in both are compared (an operation may append new
/// connections, but never removes or reorders existing ones). A connection that
/// will not be written (see [`reloaded_connection_id`]) reports no change.
pub fn diff_connection_ids(
    before: &[String],
    connections: &[SavedConnection],
    folders: &[ConnectionFolder],
) -> Vec<ConnectionIdChange> {
    before
        .iter()
        .zip(connections)
        .filter_map(|(old_id, conn)| {
            let new_id = reloaded_connection_id(conn, folders)?;
            (*old_id != new_id).then(|| ConnectionIdChange::new(old_id.clone(), new_id))
        })
        .collect()
}

/// A lookup applying one batch of [`ConnectionIdChange`]s to stored references
/// (#3596). The changes of a batch apply **simultaneously**: `a→b, b→c` maps `a`
/// to `b` and `b` to `c` (not `a` to `c`), and a swap `a→b, b→a` exchanges the
/// two. Ids not in the batch are left alone. Mirrors the frontend's
/// `connectionIdRemapper` (`src/utils/connectionIdChanges.ts`).
///
/// Applying a batch is a one-shot step, not an idempotent one: re-applying a
/// chain or swap moves the references again. Each batch is reported exactly
/// once, right after it was persisted, so every store applies it exactly once.
#[derive(Debug, Clone, Default)]
pub struct ConnectionIdRemap {
    by_old: HashMap<String, String>,
}

impl ConnectionIdRemap {
    pub fn new(changes: &[ConnectionIdChange]) -> Self {
        Self {
            by_old: changes
                .iter()
                .filter(|c| c.old_id != c.new_id)
                .map(|c| (c.old_id.clone(), c.new_id.clone()))
                .collect(),
        }
    }

    /// Whether the batch changes no id at all.
    pub fn is_empty(&self) -> bool {
        self.by_old.is_empty()
    }

    /// The new id of `id`, or `None` when the batch leaves it unchanged.
    pub fn new_id(&self, id: &str) -> Option<&str> {
        self.by_old.get(id).map(String::as_str)
    }

    /// Re-point one stored reference; returns whether it changed.
    pub fn apply(&self, id: &mut String) -> bool {
        match self.new_id(id) {
            Some(new_id) => {
                *id = new_id.to_string();
                true
            }
            None => false,
        }
    }

    /// Re-point every reference in `ids`; returns whether any changed.
    pub fn apply_all<'a>(&self, ids: impl IntoIterator<Item = &'a mut String>) -> bool {
        ids.into_iter()
            .fold(false, |changed, id| self.apply(id) | changed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::backend::ConnectionConfig;

    fn conn(id: &str, name: &str, folder_id: Option<&str>) -> SavedConnection {
        SavedConnection {
            id: id.to_string(),
            name: name.to_string(),
            config: ConnectionConfig {
                type_id: "local".to_string(),
                settings: serde_json::json!({}),
            },
            folder_id: folder_id.map(String::from),
            terminal_options: None,
            icon: None,
            source_file: None,
        }
    }

    fn folder(id: &str, name: &str, parent_id: Option<&str>) -> ConnectionFolder {
        ConnectionFolder {
            id: id.to_string(),
            name: name.to_string(),
            parent_id: parent_id.map(String::from),
            is_expanded: true,
        }
    }

    #[test]
    fn reloaded_id_follows_folder_names_not_stale_ids() {
        // The folder `Work` was renamed to `Job` but its id is still stale.
        let folders = vec![
            folder("Work", "Job", None),
            folder("Work/Db", "Db", Some("Work")),
        ];
        let c = conn("Work/Db/pg", "pg", Some("Work/Db"));
        assert_eq!(
            reloaded_connection_id(&c, &folders).as_deref(),
            Some("Job/Db/pg")
        );
    }

    #[test]
    fn a_connection_in_a_missing_or_cyclic_folder_has_no_reloaded_id() {
        assert_eq!(
            reloaded_connection_id(&conn("x", "x", Some("Gone")), &[]),
            None
        );
        let cyclic = vec![folder("A", "A", Some("B")), folder("B", "B", Some("A"))];
        assert_eq!(
            reloaded_connection_id(&conn("A/x", "x", Some("A")), &cyclic),
            None
        );
    }

    #[test]
    fn diff_reports_only_changed_and_ignores_appended_connections() {
        let folders = vec![folder("Job", "Job", None)];
        let before = vec!["Work/a".to_string(), "b".to_string()];
        let after = vec![
            conn("Job/a", "a", Some("Job")),
            conn("b", "b", None),
            conn("new", "new", None),
        ];
        assert_eq!(
            diff_connection_ids(&before, &after, &folders),
            vec![ConnectionIdChange::new("Work/a", "Job/a")]
        );
    }

    fn remap(changes: &[(&str, &str)]) -> ConnectionIdRemap {
        let changes: Vec<ConnectionIdChange> = changes
            .iter()
            .map(|(o, n)| ConnectionIdChange::new(*o, *n))
            .collect();
        ConnectionIdRemap::new(&changes)
    }

    #[test]
    fn remap_applies_a_chain_simultaneously() {
        let r = remap(&[("a", "b"), ("b", "c")]);
        let mut ids = vec!["a".to_string(), "b".to_string(), "x".to_string()];
        assert!(r.apply_all(ids.iter_mut()));
        assert_eq!(ids, ["b", "c", "x"]);
    }

    #[test]
    fn remap_exchanges_a_swap() {
        let r = remap(&[("a", "b"), ("b", "a")]);
        let mut ids = vec!["a".to_string(), "b".to_string()];
        assert!(r.apply_all(ids.iter_mut()));
        assert_eq!(ids, ["b", "a"]);
    }

    #[test]
    fn remap_leaves_unknown_ids_alone_and_reports_no_change() {
        let r = remap(&[("a", "b")]);
        let mut id = "z".to_string();
        assert!(!r.apply(&mut id));
        assert_eq!(id, "z");
        assert!(remap(&[]).is_empty());
        assert!(remap(&[("same", "same")]).is_empty());
    }
}
