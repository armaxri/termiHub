use super::config::{ConnectionFolder, ConnectionTreeNode, SavedConnection};

/// URL-encode a single path component so that `/` in names doesn't collide
/// with the path separator.
fn encode_component(s: &str) -> String {
    s.replace('%', "%25").replace('/', "%2F")
}

/// Build a path-based ID by joining an optional parent path with a name.
fn join_path(parent: Option<&str>, name: &str) -> String {
    let encoded = encode_component(name);
    match parent {
        Some(p) if !p.is_empty() => format!("{}/{}", p, encoded),
        _ => encoded,
    }
}

/// Compute a deterministic folder ID from its position in the tree.
pub fn compute_folder_id(parent_path: Option<&str>, name: &str) -> String {
    join_path(parent_path, name)
}

/// Compute a deterministic connection ID from its position in the tree.
pub fn compute_connection_id(folder_path: Option<&str>, name: &str) -> String {
    join_path(folder_path, name)
}

/// Convert a nested tree of [`ConnectionTreeNode`]s into flat arrays of
/// [`SavedConnection`]s and [`ConnectionFolder`]s with generated path-based IDs.
pub fn flatten_tree(
    children: &[ConnectionTreeNode],
    parent_path: Option<&str>,
) -> (Vec<SavedConnection>, Vec<ConnectionFolder>) {
    let mut connections = Vec::new();
    let mut folders = Vec::new();

    let parent_folder_id = parent_path.map(String::from);

    for node in children {
        match node {
            ConnectionTreeNode::Folder {
                name,
                is_expanded,
                children: child_nodes,
            } => {
                let folder_id = compute_folder_id(parent_path, name);
                folders.push(ConnectionFolder {
                    id: folder_id.clone(),
                    name: name.clone(),
                    parent_id: parent_folder_id.clone(),
                    is_expanded: *is_expanded,
                });
                let (child_conns, child_folders) = flatten_tree(child_nodes, Some(&folder_id));
                connections.extend(child_conns);
                folders.extend(child_folders);
            }
            ConnectionTreeNode::Connection {
                name,
                config,
                terminal_options,
            } => {
                let conn_id = compute_connection_id(parent_path, name);
                connections.push(SavedConnection {
                    id: conn_id,
                    name: name.clone(),
                    config: config.clone(),
                    folder_id: parent_folder_id.clone(),
                    terminal_options: terminal_options.clone(),
                    source_file: None,
                });
            }
        }
    }

    (connections, folders)
}

/// Convert flat arrays of connections and folders back into a nested tree
/// suitable for serialization to disk.
///
/// Within each parent, subfolders come first (preserving order), then
/// connections (preserving order). This matches the UI render order.
pub fn build_tree(
    connections: &[SavedConnection],
    folders: &[ConnectionFolder],
) -> Vec<ConnectionTreeNode> {
    build_tree_for_parent(connections, folders, None)
}

fn build_tree_for_parent(
    connections: &[SavedConnection],
    folders: &[ConnectionFolder],
    parent_id: Option<&str>,
) -> Vec<ConnectionTreeNode> {
    let mut nodes = Vec::new();

    // Add child folders first (preserving order)
    for folder in folders {
        let folder_parent = folder.parent_id.as_deref();
        if folder_parent == parent_id {
            let children = build_tree_for_parent(connections, folders, Some(&folder.id));
            nodes.push(ConnectionTreeNode::Folder {
                name: folder.name.clone(),
                is_expanded: folder.is_expanded,
                children,
            });
        }
    }

    // Then add child connections (preserving order)
    for conn in connections {
        let conn_parent = conn.folder_id.as_deref();
        if conn_parent == parent_id {
            nodes.push(ConnectionTreeNode::Connection {
                name: conn.name.clone(),
                config: conn.config.clone(),
                terminal_options: conn.terminal_options.clone(),
            });
        }
    }

    nodes
}

/// Ensure no two siblings (connections or folders) share the same name
/// within the same parent.
///
/// Duplicates are renamed to `<name> (1)`, `<name> (2)`, etc.
/// The first occurrence keeps its original name.
pub fn deduplicate_sibling_names(
    connections: &mut [SavedConnection],
    folders: &mut [ConnectionFolder],
) {
    // Collect all unique parent IDs (including None for root)
    let mut parent_ids: Vec<Option<String>> = vec![None];
    for folder in folders.iter() {
        if !parent_ids.contains(&Some(folder.id.clone())) {
            parent_ids.push(Some(folder.id.clone()));
        }
    }

    for parent_id in &parent_ids {
        let parent_ref = parent_id.as_deref();

        // Collect all sibling names (folders first, then connections)
        // to determine which are duplicates
        let mut seen_names: Vec<String> = Vec::new();

        // Process folders in this parent
        let folder_indices: Vec<usize> = folders
            .iter()
            .enumerate()
            .filter(|(_, f)| f.parent_id.as_deref() == parent_ref)
            .map(|(i, _)| i)
            .collect();

        for idx in folder_indices {
            let name = folders[idx].name.clone();
            let unique_name = find_unique_name(&name, &seen_names);
            if unique_name != name {
                folders[idx].name = unique_name.clone();
                // Update the folder's ID and all references to it
                let old_id = folders[idx].id.clone();
                let new_id = compute_folder_id(parent_ref, &unique_name);
                rename_folder_references(connections, folders, &old_id, &new_id, idx);
            }
            seen_names.push(folders[idx].name.clone());
        }

        // Process connections in this parent
        let conn_indices: Vec<usize> = connections
            .iter()
            .enumerate()
            .filter(|(_, c)| c.folder_id.as_deref() == parent_ref)
            .map(|(i, _)| i)
            .collect();

        for idx in conn_indices {
            let name = connections[idx].name.clone();
            let unique_name = find_unique_name(&name, &seen_names);
            if unique_name != name {
                connections[idx].name = unique_name.clone();
                connections[idx].id = compute_connection_id(parent_ref, &unique_name);
            }
            seen_names.push(connections[idx].name.clone());
        }
    }
}

/// Find a unique name given existing sibling names.
///
/// If `name` is not in `existing`, returns it unchanged.
/// Otherwise, returns `<name> (N)` where N is the smallest positive
/// integer such that the result is not in `existing`.
fn find_unique_name(name: &str, existing: &[String]) -> String {
    if !existing.iter().any(|n| n == name) {
        return name.to_string();
    }

    let mut counter = 1;
    loop {
        let candidate = format!("{} ({})", name, counter);
        if !existing.iter().any(|n| n == &candidate) {
            return candidate;
        }
        counter += 1;
    }
}

/// Update all references when a folder is renamed (ID changes).
fn rename_folder_references(
    connections: &mut [SavedConnection],
    folders: &mut [ConnectionFolder],
    old_id: &str,
    new_id: &str,
    folder_idx: usize,
) {
    // Update the folder's own ID
    folders[folder_idx].id = new_id.to_string();

    // Update child folders' parent_id
    for folder in folders.iter_mut() {
        if folder.parent_id.as_deref() == Some(old_id) {
            folder.parent_id = Some(new_id.to_string());
        }
    }

    // Update child connections' folder_id
    for conn in connections.iter_mut() {
        if conn.folder_id.as_deref() == Some(old_id) {
            conn.folder_id = Some(new_id.to_string());
            // Recompute connection ID since its folder changed
            conn.id = compute_connection_id(Some(new_id), &conn.name);
        }
    }
}

/// Count connections and folders in a tree (recursively).
pub fn count_tree_items(children: &[ConnectionTreeNode]) -> (usize, usize) {
    let mut conn_count = 0;
    let mut folder_count = 0;
    for node in children {
        match node {
            ConnectionTreeNode::Folder { children, .. } => {
                folder_count += 1;
                let (c, f) = count_tree_items(children);
                conn_count += c;
                folder_count += f;
            }
            ConnectionTreeNode::Connection { .. } => {
                conn_count += 1;
            }
        }
    }
    (conn_count, folder_count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::backend::ConnectionConfig;

    fn make_local_config() -> ConnectionConfig {
        ConnectionConfig {
            type_id: "local".to_string(),
            settings: serde_json::json!({"shellType": "bash"}),
        }
    }

    fn make_ssh_config() -> ConnectionConfig {
        ConnectionConfig {
            type_id: "ssh".to_string(),
            settings: serde_json::json!({
                "host": "example.com",
                "port": 22,
                "username": "admin",
                "authMethod": "password"
            }),
        }
    }

    // -----------------------------------------------------------------------
    // Path encoding
    // -----------------------------------------------------------------------

    #[test]
    fn encode_component_leaves_normal_names_unchanged() {
        assert_eq!(encode_component("Work"), "Work");
        assert_eq!(encode_component("My SSH"), "My SSH");
    }

    #[test]
    fn encode_component_encodes_slash() {
        assert_eq!(encode_component("A/B"), "A%2FB");
    }

    #[test]
    fn encode_component_encodes_percent_first() {
        assert_eq!(encode_component("100%"), "100%25");
        assert_eq!(encode_component("a%2Fb"), "a%252Fb");
    }

    #[test]
    fn join_path_root_level() {
        assert_eq!(join_path(None, "Work"), "Work");
        assert_eq!(join_path(Some(""), "Work"), "Work");
    }

    #[test]
    fn join_path_nested() {
        assert_eq!(join_path(Some("Work"), "Dev"), "Work/Dev");
        assert_eq!(join_path(Some("Work/Dev"), "My SSH"), "Work/Dev/My SSH");
    }

    // -----------------------------------------------------------------------
    // flatten_tree
    // -----------------------------------------------------------------------

    #[test]
    fn flatten_empty_tree() {
        let (conns, folders) = flatten_tree(&[], None);
        assert!(conns.is_empty());
        assert!(folders.is_empty());
    }

    #[test]
    fn flatten_root_connections_only() {
        let tree = vec![
            ConnectionTreeNode::Connection {
                name: "Local".to_string(),
                config: make_local_config(),
                terminal_options: None,
            },
            ConnectionTreeNode::Connection {
                name: "SSH".to_string(),
                config: make_ssh_config(),
                terminal_options: None,
            },
        ];

        let (conns, folders) = flatten_tree(&tree, None);
        assert_eq!(conns.len(), 2);
        assert!(folders.is_empty());
        assert_eq!(conns[0].id, "Local");
        assert_eq!(conns[0].name, "Local");
        assert_eq!(conns[0].folder_id, None);
        assert_eq!(conns[1].id, "SSH");
        assert_eq!(conns[1].folder_id, None);
    }

    #[test]
    fn flatten_folder_with_connections() {
        let tree = vec![ConnectionTreeNode::Folder {
            name: "Work".to_string(),
            is_expanded: true,
            children: vec![
                ConnectionTreeNode::Connection {
                    name: "Prod".to_string(),
                    config: make_ssh_config(),
                    terminal_options: None,
                },
                ConnectionTreeNode::Connection {
                    name: "Dev".to_string(),
                    config: make_ssh_config(),
                    terminal_options: None,
                },
            ],
        }];

        let (conns, folders) = flatten_tree(&tree, None);
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].id, "Work");
        assert_eq!(folders[0].name, "Work");
        assert_eq!(folders[0].parent_id, None);
        assert!(folders[0].is_expanded);

        assert_eq!(conns.len(), 2);
        assert_eq!(conns[0].id, "Work/Prod");
        assert_eq!(conns[0].folder_id.as_deref(), Some("Work"));
        assert_eq!(conns[1].id, "Work/Dev");
    }

    #[test]
    fn flatten_nested_folders() {
        let tree = vec![ConnectionTreeNode::Folder {
            name: "Root Folder".to_string(),
            is_expanded: true,
            children: vec![ConnectionTreeNode::Folder {
                name: "Sub Folder".to_string(),
                is_expanded: false,
                children: vec![ConnectionTreeNode::Connection {
                    name: "Deep SSH".to_string(),
                    config: make_ssh_config(),
                    terminal_options: None,
                }],
            }],
        }];

        let (conns, folders) = flatten_tree(&tree, None);
        assert_eq!(folders.len(), 2);
        assert_eq!(folders[0].id, "Root Folder");
        assert_eq!(folders[0].parent_id, None);
        assert_eq!(folders[1].id, "Root Folder/Sub Folder");
        assert_eq!(folders[1].parent_id.as_deref(), Some("Root Folder"));

        assert_eq!(conns.len(), 1);
        assert_eq!(conns[0].id, "Root Folder/Sub Folder/Deep SSH");
        assert_eq!(
            conns[0].folder_id.as_deref(),
            Some("Root Folder/Sub Folder")
        );
    }

    #[test]
    fn flatten_handles_slash_in_name() {
        let tree = vec![ConnectionTreeNode::Connection {
            name: "A/B".to_string(),
            config: make_local_config(),
            terminal_options: None,
        }];

        let (conns, _) = flatten_tree(&tree, None);
        assert_eq!(conns[0].id, "A%2FB");
        assert_eq!(conns[0].name, "A/B");
    }

    // -----------------------------------------------------------------------
    // build_tree
    // -----------------------------------------------------------------------

    #[test]
    fn build_tree_empty() {
        let tree = build_tree(&[], &[]);
        assert!(tree.is_empty());
    }

    #[test]
    fn build_tree_root_connections() {
        let conns = vec![
            SavedConnection {
                id: "Local".to_string(),
                name: "Local".to_string(),
                config: make_local_config(),
                folder_id: None,
                terminal_options: None,
                source_file: None,
            },
            SavedConnection {
                id: "SSH".to_string(),
                name: "SSH".to_string(),
                config: make_ssh_config(),
                folder_id: None,
                terminal_options: None,
                source_file: None,
            },
        ];

        let tree = build_tree(&conns, &[]);
        assert_eq!(tree.len(), 2);
        match &tree[0] {
            ConnectionTreeNode::Connection { name, .. } => {
                assert_eq!(name, "Local");
            }
            _ => panic!("Expected Connection"),
        }
    }

    #[test]
    fn build_tree_with_folders() {
        let folders = vec![ConnectionFolder {
            id: "Work".to_string(),
            name: "Work".to_string(),
            parent_id: None,
            is_expanded: true,
        }];
        let conns = vec![
            SavedConnection {
                id: "Work/Prod".to_string(),
                name: "Prod".to_string(),
                config: make_ssh_config(),
                folder_id: Some("Work".to_string()),
                terminal_options: None,
                source_file: None,
            },
            SavedConnection {
                id: "Root Conn".to_string(),
                name: "Root Conn".to_string(),
                config: make_local_config(),
                folder_id: None,
                terminal_options: None,
                source_file: None,
            },
        ];

        let tree = build_tree(&conns, &folders);
        // Folders first, then root connections
        assert_eq!(tree.len(), 2);
        match &tree[0] {
            ConnectionTreeNode::Folder { name, children, .. } => {
                assert_eq!(name, "Work");
                assert_eq!(children.len(), 1);
            }
            _ => panic!("Expected Folder first"),
        }
        match &tree[1] {
            ConnectionTreeNode::Connection { name, .. } => {
                assert_eq!(name, "Root Conn");
            }
            _ => panic!("Expected Connection second"),
        }
    }

    // -----------------------------------------------------------------------
    // Round-trip: flatten -> build -> flatten
    // -----------------------------------------------------------------------

    #[test]
    fn round_trip_flat_tree_flat() {
        let original_tree = vec![
            ConnectionTreeNode::Folder {
                name: "Work".to_string(),
                is_expanded: true,
                children: vec![
                    ConnectionTreeNode::Folder {
                        name: "Dev".to_string(),
                        is_expanded: false,
                        children: vec![ConnectionTreeNode::Connection {
                            name: "Dev SSH".to_string(),
                            config: make_ssh_config(),
                            terminal_options: None,
                        }],
                    },
                    ConnectionTreeNode::Connection {
                        name: "Prod SSH".to_string(),
                        config: make_ssh_config(),
                        terminal_options: None,
                    },
                ],
            },
            ConnectionTreeNode::Connection {
                name: "Local".to_string(),
                config: make_local_config(),
                terminal_options: None,
            },
        ];

        // Flatten
        let (conns, folders) = flatten_tree(&original_tree, None);
        assert_eq!(conns.len(), 3);
        assert_eq!(folders.len(), 2);

        // Rebuild
        let rebuilt = build_tree(&conns, &folders);
        assert_eq!(rebuilt.len(), 2); // Work folder + Local connection

        // Flatten again — should produce same results
        let (conns2, folders2) = flatten_tree(&rebuilt, None);
        assert_eq!(conns.len(), conns2.len());
        assert_eq!(folders.len(), folders2.len());

        for (a, b) in conns.iter().zip(conns2.iter()) {
            assert_eq!(a.id, b.id);
            assert_eq!(a.name, b.name);
            assert_eq!(a.folder_id, b.folder_id);
        }
        for (a, b) in folders.iter().zip(folders2.iter()) {
            assert_eq!(a.id, b.id);
            assert_eq!(a.name, b.name);
            assert_eq!(a.parent_id, b.parent_id);
        }
    }

    // -----------------------------------------------------------------------
    // deduplicate_sibling_names
    // -----------------------------------------------------------------------

    #[test]
    fn dedup_no_duplicates() {
        let mut conns = vec![
            SavedConnection {
                id: "A".to_string(),
                name: "A".to_string(),
                config: make_local_config(),
                folder_id: None,
                terminal_options: None,
                source_file: None,
            },
            SavedConnection {
                id: "B".to_string(),
                name: "B".to_string(),
                config: make_local_config(),
                folder_id: None,
                terminal_options: None,
                source_file: None,
            },
        ];
        let mut folders = vec![];

        deduplicate_sibling_names(&mut conns, &mut folders);
        assert_eq!(conns[0].name, "A");
        assert_eq!(conns[1].name, "B");
    }

    #[test]
    fn dedup_same_name_connections_in_root() {
        let mut conns = vec![
            SavedConnection {
                id: "SSH".to_string(),
                name: "SSH".to_string(),
                config: make_ssh_config(),
                folder_id: None,
                terminal_options: None,
                source_file: None,
            },
            SavedConnection {
                id: "SSH".to_string(),
                name: "SSH".to_string(),
                config: make_ssh_config(),
                folder_id: None,
                terminal_options: None,
                source_file: None,
            },
        ];
        let mut folders = vec![];

        deduplicate_sibling_names(&mut conns, &mut folders);
        assert_eq!(conns[0].name, "SSH");
        assert_eq!(conns[1].name, "SSH (1)");
    }

    #[test]
    fn dedup_three_same_name() {
        let mut conns = vec![
            SavedConnection {
                id: "X".to_string(),
                name: "X".to_string(),
                config: make_local_config(),
                folder_id: None,
                terminal_options: None,
                source_file: None,
            },
            SavedConnection {
                id: "X".to_string(),
                name: "X".to_string(),
                config: make_local_config(),
                folder_id: None,
                terminal_options: None,
                source_file: None,
            },
            SavedConnection {
                id: "X".to_string(),
                name: "X".to_string(),
                config: make_local_config(),
                folder_id: None,
                terminal_options: None,
                source_file: None,
            },
        ];
        let mut folders = vec![];

        deduplicate_sibling_names(&mut conns, &mut folders);
        assert_eq!(conns[0].name, "X");
        assert_eq!(conns[1].name, "X (1)");
        assert_eq!(conns[2].name, "X (2)");
    }

    #[test]
    fn dedup_skips_existing_suffix() {
        let mut conns = vec![
            SavedConnection {
                id: "A".to_string(),
                name: "A".to_string(),
                config: make_local_config(),
                folder_id: None,
                terminal_options: None,
                source_file: None,
            },
            SavedConnection {
                id: "A (1)".to_string(),
                name: "A (1)".to_string(),
                config: make_local_config(),
                folder_id: None,
                terminal_options: None,
                source_file: None,
            },
            SavedConnection {
                id: "A".to_string(),
                name: "A".to_string(),
                config: make_local_config(),
                folder_id: None,
                terminal_options: None,
                source_file: None,
            },
        ];
        let mut folders = vec![];

        deduplicate_sibling_names(&mut conns, &mut folders);
        assert_eq!(conns[0].name, "A");
        assert_eq!(conns[1].name, "A (1)");
        // Should skip (1) since it exists and use (2)
        assert_eq!(conns[2].name, "A (2)");
    }

    #[test]
    fn dedup_different_folders_no_conflict() {
        let mut folders = vec![
            ConnectionFolder {
                id: "F1".to_string(),
                name: "F1".to_string(),
                parent_id: None,
                is_expanded: true,
            },
            ConnectionFolder {
                id: "F2".to_string(),
                name: "F2".to_string(),
                parent_id: None,
                is_expanded: true,
            },
        ];
        let mut conns = vec![
            SavedConnection {
                id: "F1/SSH".to_string(),
                name: "SSH".to_string(),
                config: make_ssh_config(),
                folder_id: Some("F1".to_string()),
                terminal_options: None,
                source_file: None,
            },
            SavedConnection {
                id: "F2/SSH".to_string(),
                name: "SSH".to_string(),
                config: make_ssh_config(),
                folder_id: Some("F2".to_string()),
                terminal_options: None,
                source_file: None,
            },
        ];

        deduplicate_sibling_names(&mut conns, &mut folders);
        // Same name in different folders should NOT be renamed
        assert_eq!(conns[0].name, "SSH");
        assert_eq!(conns[1].name, "SSH");
    }

    #[test]
    fn dedup_folder_and_connection_same_name() {
        let mut folders = vec![ConnectionFolder {
            id: "Work".to_string(),
            name: "Work".to_string(),
            parent_id: None,
            is_expanded: true,
        }];
        let mut conns = vec![SavedConnection {
            id: "Work".to_string(),
            name: "Work".to_string(),
            config: make_local_config(),
            folder_id: None,
            terminal_options: None,
            source_file: None,
        }];

        deduplicate_sibling_names(&mut conns, &mut folders);
        // Folder keeps its name, connection gets renamed
        assert_eq!(folders[0].name, "Work");
        assert_eq!(conns[0].name, "Work (1)");
    }

    #[test]
    fn dedup_duplicate_folder_names() {
        let mut folders = vec![
            ConnectionFolder {
                id: "Work".to_string(),
                name: "Work".to_string(),
                parent_id: None,
                is_expanded: true,
            },
            ConnectionFolder {
                id: "Work2".to_string(),
                name: "Work".to_string(),
                parent_id: None,
                is_expanded: false,
            },
        ];
        let mut conns = vec![];

        deduplicate_sibling_names(&mut conns, &mut folders);
        assert_eq!(folders[0].name, "Work");
        assert_eq!(folders[1].name, "Work (1)");
    }

    // -----------------------------------------------------------------------
    // Regression: drag-and-drop move into folder with same-name sibling
    // -----------------------------------------------------------------------

    #[test]
    fn dedup_move_connection_into_folder_with_same_name_sibling() {
        // Simulates the scenario: connection "Zsh" at root is moved into
        // folder "TestDir" which already contains a connection named "Zsh".
        // After the move, the connection has folder_id = "TestDir" but its
        // ID has been recomputed to "TestDir/Zsh", colliding with the
        // existing connection's ID.
        let mut folders = vec![ConnectionFolder {
            id: "TestDir".to_string(),
            name: "TestDir".to_string(),
            parent_id: None,
            is_expanded: true,
        }];
        let mut conns = vec![
            // Existing connection in folder
            SavedConnection {
                id: "TestDir/Zsh".to_string(),
                name: "Zsh".to_string(),
                config: make_local_config(),
                folder_id: Some("TestDir".to_string()),
                terminal_options: None,
                source_file: None,
            },
            // Moved connection: ID recomputed to match new folder
            SavedConnection {
                id: "TestDir/Zsh".to_string(),
                name: "Zsh".to_string(),
                config: make_local_config(),
                folder_id: Some("TestDir".to_string()),
                terminal_options: None,
                source_file: None,
            },
        ];

        deduplicate_sibling_names(&mut conns, &mut folders);

        // First connection keeps its name
        assert_eq!(conns[0].name, "Zsh");
        assert_eq!(conns[0].id, "TestDir/Zsh");
        // Second (moved) connection gets renamed
        assert_eq!(conns[1].name, "Zsh (1)");
        assert_eq!(conns[1].id, "TestDir/Zsh (1)");
    }

    // -----------------------------------------------------------------------
    // count_tree_items
    // -----------------------------------------------------------------------

    #[test]
    fn count_tree_items_empty() {
        assert_eq!(count_tree_items(&[]), (0, 0));
    }

    #[test]
    fn count_tree_items_mixed() {
        let tree = vec![
            ConnectionTreeNode::Folder {
                name: "F".to_string(),
                is_expanded: true,
                children: vec![
                    ConnectionTreeNode::Connection {
                        name: "C1".to_string(),
                        config: make_local_config(),
                        terminal_options: None,
                    },
                    ConnectionTreeNode::Connection {
                        name: "C2".to_string(),
                        config: make_local_config(),
                        terminal_options: None,
                    },
                ],
            },
            ConnectionTreeNode::Connection {
                name: "C3".to_string(),
                config: make_local_config(),
                terminal_options: None,
            },
        ];
        assert_eq!(count_tree_items(&tree), (3, 1));
    }
}
