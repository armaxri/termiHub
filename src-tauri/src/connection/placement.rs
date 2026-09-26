//! Placing a saved connection into a flat connection tree (#3577).
//!
//! A tree only writes a connection whose folder chain it contains, so a
//! connection placed under a folder the tree lacks would be silently dropped
//! on the next write. [`place_connection`] re-homes such a connection — into a
//! copy of its folder chain when one is at hand, otherwise to the root —
//! recomputes its id, deduplicates sibling names like every other save, and
//! reports every id change so bookmarks and credentials can follow.

use super::config::{ConnectionFolder, SavedConnection};
use super::id_changes::{diff_connection_ids, reloaded_connection_id, ConnectionIdChange};
use super::tree::{compute_connection_id, deduplicate_sibling_names};

/// Deepest folder chain copied into a tree; anything deeper is a cycle.
const MAX_CHAIN_DEPTH: usize = 256;

/// How [`place_connection`] treats a connection with the same id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlaceMode {
    /// Update the connection with the same id, or append when there is none.
    ReplaceById,
    /// Always append — a connection arriving from another file must never
    /// overwrite a resident one that happens to share its id.
    Append,
}

/// The outcome of [`place_connection`].
#[derive(Debug)]
pub(crate) struct Placement {
    /// Where the placed connection now sits in the connection list.
    pub index: usize,
    /// Every connection id the placement changed, including the placed
    /// connection's own (from the id it arrived with).
    pub changes: Vec<ConnectionIdChange>,
}

/// Put `connection` into `connections`, keeping it writable.
///
/// When its folder is not part of `folders`, the folder chain is copied from
/// `folder_source` (e.g. the main store's folders, which the unified view shows
/// external connections under); when that is impossible too, the connection
/// moves to the root. Its id is then recomputed and sibling names are
/// deduplicated (the connection already at a name keeps it).
pub(crate) fn place_connection(
    connections: &mut Vec<SavedConnection>,
    folders: &mut Vec<ConnectionFolder>,
    connection: SavedConnection,
    mode: PlaceMode,
    folder_source: &[ConnectionFolder],
) -> Placement {
    let ids_before: Vec<String> = connections.iter().map(|c| c.id.clone()).collect();
    let arrived_as = connection.id.clone();
    let existing = match mode {
        PlaceMode::ReplaceById => connections.iter().position(|c| c.id == connection.id),
        PlaceMode::Append => None,
    };
    let index = match existing {
        Some(idx) => {
            connections[idx] = connection;
            idx
        }
        None => {
            connections.push(connection);
            connections.len() - 1
        }
    };

    ensure_folder(&mut connections[index], folders, folder_source);
    connections[index].id = placed_id(&connections[index], folders);
    deduplicate_sibling_names(connections, folders);
    connections[index].id = placed_id(&connections[index], folders);

    let mut changes = diff_connection_ids(&ids_before, connections, folders);
    let placed = &connections[index].id;
    if index >= ids_before.len() && arrived_as != *placed {
        changes.push(ConnectionIdChange::new(arrived_as, placed.clone()));
    }
    Placement { index, changes }
}

/// The id `connection` gets when the tree is loaded again.
fn placed_id(connection: &SavedConnection, folders: &[ConnectionFolder]) -> String {
    reloaded_connection_id(connection, folders)
        .unwrap_or_else(|| compute_connection_id(connection.folder_id.as_deref(), &connection.name))
}

/// Make `connection`'s folder resolvable in `folders`, or move it to the root.
fn ensure_folder(
    connection: &mut SavedConnection,
    folders: &mut Vec<ConnectionFolder>,
    folder_source: &[ConnectionFolder],
) {
    let Some(folder_id) = connection.folder_id.clone() else {
        return;
    };
    if reloaded_connection_id(connection, folders).is_some() {
        return;
    }
    if let Some(chain) = missing_chain(&folder_id, folders, folder_source) {
        let before = folders.len();
        folders.extend(chain);
        if reloaded_connection_id(connection, folders).is_some() {
            return;
        }
        folders.truncate(before);
    }
    connection.folder_id = None;
}

/// The folders of `folder_id`'s chain that `folders` lacks, copied from
/// `folder_source` (outermost first). `None` when the chain cannot be found.
fn missing_chain(
    folder_id: &str,
    folders: &[ConnectionFolder],
    folder_source: &[ConnectionFolder],
) -> Option<Vec<ConnectionFolder>> {
    let mut chain = Vec::new();
    let mut current = Some(folder_id.to_string());
    while let Some(id) = current {
        if folders.iter().any(|f| f.id == id) {
            break;
        }
        if chain.len() > MAX_CHAIN_DEPTH {
            return None;
        }
        let folder = folder_source.iter().find(|f| f.id == id)?;
        current = folder.parent_id.clone();
        chain.push(folder.clone());
    }
    chain.reverse();
    Some(chain)
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
    fn a_connection_in_a_missing_folder_moves_to_the_root() {
        let mut conns = Vec::new();
        let mut folders = Vec::new();
        let p = place_connection(
            &mut conns,
            &mut folders,
            conn("X/n", "n", Some("X")),
            PlaceMode::Append,
            &[],
        );
        assert_eq!(conns[p.index].folder_id, None);
        assert_eq!(conns[p.index].id, "n");
        assert_eq!(p.changes, vec![ConnectionIdChange::new("X/n", "n")]);
    }

    #[test]
    fn a_missing_folder_chain_is_copied_from_the_source() {
        let source = vec![folder("F", "F", None), folder("F/G", "G", Some("F"))];
        let mut conns = Vec::new();
        let mut folders = Vec::new();
        let p = place_connection(
            &mut conns,
            &mut folders,
            conn("F/G/a", "a", Some("F/G")),
            PlaceMode::Append,
            &source,
        );
        assert_eq!(folders.len(), 2);
        assert_eq!(conns[p.index].id, "F/G/a");
        assert!(p.changes.is_empty());
    }

    #[test]
    fn append_never_overwrites_a_resident_with_the_same_id() {
        let mut conns = vec![conn("n", "n", None)];
        let mut folders = Vec::new();
        let p = place_connection(
            &mut conns,
            &mut folders,
            conn("n", "n", None),
            PlaceMode::Append,
            &[],
        );
        assert_eq!(conns.len(), 2);
        assert_eq!(conns[0].id, "n");
        assert_eq!(conns[p.index].id, "n (1)");
        assert_eq!(p.changes, vec![ConnectionIdChange::new("n", "n (1)")]);
    }
}
