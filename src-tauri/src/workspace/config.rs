use serde::{Deserialize, Serialize};

/// A tab definition within a workspace leaf panel.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTabDef {
    /// Reference to a saved connection by ID (preferred).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_ref: Option<String>,
    /// Inline connection config as fallback when no saved connection is referenced.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inline_config: Option<serde_json::Value>,
    /// Optional title override for the tab.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Optional command to run after the session connects.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_command: Option<String>,
}

/// Recursive layout tree for a workspace.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WorkspaceLayoutNode {
    /// A leaf panel containing one or more tabs.
    Leaf { tabs: Vec<WorkspaceTabDef> },
    /// A split container with child panels.
    Split {
        direction: SplitDirection,
        children: Vec<WorkspaceLayoutNode>,
    },
}

/// Split direction for layout containers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum SplitDirection {
    Horizontal,
    Vertical,
}

/// A complete workspace definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDefinition {
    /// Unique workspace identifier.
    pub id: String,
    /// User-friendly name for this workspace.
    pub name: String,
    /// Optional description.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The layout tree defining panels and their connections.
    pub layout: WorkspaceLayoutNode,
}

/// Summary of a workspace for list display (without full layout details).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummary {
    /// Unique workspace identifier.
    pub id: String,
    /// User-friendly name.
    pub name: String,
    /// Optional description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Number of connections in this workspace.
    pub connection_count: usize,
}

impl WorkspaceDefinition {
    /// Create a summary for list display.
    pub fn to_summary(&self) -> WorkspaceSummary {
        WorkspaceSummary {
            id: self.id.clone(),
            name: self.name.clone(),
            description: self.description.clone(),
            connection_count: count_tabs(&self.layout),
        }
    }
}

/// Count the total number of tabs in a layout tree.
fn count_tabs(node: &WorkspaceLayoutNode) -> usize {
    match node {
        WorkspaceLayoutNode::Leaf { tabs } => tabs.len(),
        WorkspaceLayoutNode::Split { children, .. } => children.iter().map(count_tabs).sum(),
    }
}

/// Top-level schema for the workspaces JSON file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceStore {
    pub version: String,
    pub workspaces: Vec<WorkspaceDefinition>,
}

impl Default for WorkspaceStore {
    fn default() -> Self {
        Self {
            version: "1".to_string(),
            workspaces: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_workspace() -> WorkspaceDefinition {
        WorkspaceDefinition {
            id: "ws-1".to_string(),
            name: "Dev Setup".to_string(),
            description: Some("My daily dev layout".to_string()),
            layout: WorkspaceLayoutNode::Split {
                direction: SplitDirection::Horizontal,
                children: vec![
                    WorkspaceLayoutNode::Leaf {
                        tabs: vec![WorkspaceTabDef {
                            connection_ref: Some("conn-1".to_string()),
                            inline_config: None,
                            title: Some("Server".to_string()),
                            initial_command: Some("cd /app && npm start".to_string()),
                        }],
                    },
                    WorkspaceLayoutNode::Leaf {
                        tabs: vec![
                            WorkspaceTabDef {
                                connection_ref: Some("conn-2".to_string()),
                                inline_config: None,
                                title: None,
                                initial_command: None,
                            },
                            WorkspaceTabDef {
                                connection_ref: None,
                                inline_config: Some(serde_json::json!({
                                    "type": "local",
                                    "config": { "shell": "zsh" }
                                })),
                                title: Some("Local Shell".to_string()),
                                initial_command: None,
                            },
                        ],
                    },
                ],
            },
        }
    }

    #[test]
    fn workspace_definition_serde_round_trip() {
        let ws = sample_workspace();
        let json = serde_json::to_string(&ws).unwrap();
        let deserialized: WorkspaceDefinition = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.id, "ws-1");
        assert_eq!(deserialized.name, "Dev Setup");
        assert_eq!(
            deserialized.description.as_deref(),
            Some("My daily dev layout")
        );
    }

    #[test]
    fn workspace_layout_leaf_serde() {
        let leaf = WorkspaceLayoutNode::Leaf {
            tabs: vec![WorkspaceTabDef {
                connection_ref: Some("conn-1".to_string()),
                inline_config: None,
                title: None,
                initial_command: None,
            }],
        };
        let json = serde_json::to_string(&leaf).unwrap();
        let deserialized: WorkspaceLayoutNode = serde_json::from_str(&json).unwrap();
        if let WorkspaceLayoutNode::Leaf { tabs } = deserialized {
            assert_eq!(tabs.len(), 1);
            assert_eq!(tabs[0].connection_ref.as_deref(), Some("conn-1"));
        } else {
            panic!("Expected Leaf");
        }
    }

    #[test]
    fn workspace_layout_split_serde() {
        let split = WorkspaceLayoutNode::Split {
            direction: SplitDirection::Vertical,
            children: vec![
                WorkspaceLayoutNode::Leaf {
                    tabs: vec![WorkspaceTabDef {
                        connection_ref: Some("conn-1".to_string()),
                        inline_config: None,
                        title: None,
                        initial_command: None,
                    }],
                },
                WorkspaceLayoutNode::Leaf {
                    tabs: vec![WorkspaceTabDef {
                        connection_ref: Some("conn-2".to_string()),
                        inline_config: None,
                        title: None,
                        initial_command: None,
                    }],
                },
            ],
        };
        let json = serde_json::to_string(&split).unwrap();
        let deserialized: WorkspaceLayoutNode = serde_json::from_str(&json).unwrap();
        if let WorkspaceLayoutNode::Split {
            direction,
            children,
        } = deserialized
        {
            assert_eq!(direction, SplitDirection::Vertical);
            assert_eq!(children.len(), 2);
        } else {
            panic!("Expected Split");
        }
    }

    #[test]
    fn workspace_tab_def_with_inline_config() {
        let tab = WorkspaceTabDef {
            connection_ref: None,
            inline_config: Some(serde_json::json!({
                "type": "local",
                "config": { "shell": "bash" }
            })),
            title: Some("My Shell".to_string()),
            initial_command: Some("ls -la".to_string()),
        };
        let json = serde_json::to_string(&tab).unwrap();
        assert!(!json.contains("connectionRef"));
        let deserialized: WorkspaceTabDef = serde_json::from_str(&json).unwrap();
        assert!(deserialized.connection_ref.is_none());
        assert!(deserialized.inline_config.is_some());
        assert_eq!(deserialized.title.as_deref(), Some("My Shell"));
        assert_eq!(deserialized.initial_command.as_deref(), Some("ls -la"));
    }

    #[test]
    fn workspace_tab_def_optional_fields_omitted() {
        let tab = WorkspaceTabDef {
            connection_ref: Some("conn-1".to_string()),
            inline_config: None,
            title: None,
            initial_command: None,
        };
        let json = serde_json::to_string(&tab).unwrap();
        assert!(!json.contains("inlineConfig"));
        assert!(!json.contains("title"));
        assert!(!json.contains("initialCommand"));
    }

    #[test]
    fn workspace_summary_from_definition() {
        let ws = sample_workspace();
        let summary = ws.to_summary();
        assert_eq!(summary.id, "ws-1");
        assert_eq!(summary.name, "Dev Setup");
        assert_eq!(summary.connection_count, 3); // 1 + 2 tabs
    }

    #[test]
    fn workspace_store_serde_round_trip() {
        let store = WorkspaceStore {
            version: "1".to_string(),
            workspaces: vec![sample_workspace()],
        };
        let json = serde_json::to_string_pretty(&store).unwrap();
        let deserialized: WorkspaceStore = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.version, "1");
        assert_eq!(deserialized.workspaces.len(), 1);
    }

    #[test]
    fn workspace_store_default_is_empty() {
        let store = WorkspaceStore::default();
        assert_eq!(store.version, "1");
        assert!(store.workspaces.is_empty());
    }

    #[test]
    fn count_tabs_nested() {
        let layout = WorkspaceLayoutNode::Split {
            direction: SplitDirection::Horizontal,
            children: vec![
                WorkspaceLayoutNode::Split {
                    direction: SplitDirection::Vertical,
                    children: vec![
                        WorkspaceLayoutNode::Leaf {
                            tabs: vec![
                                WorkspaceTabDef {
                                    connection_ref: Some("a".to_string()),
                                    inline_config: None,
                                    title: None,
                                    initial_command: None,
                                },
                                WorkspaceTabDef {
                                    connection_ref: Some("b".to_string()),
                                    inline_config: None,
                                    title: None,
                                    initial_command: None,
                                },
                            ],
                        },
                        WorkspaceLayoutNode::Leaf {
                            tabs: vec![WorkspaceTabDef {
                                connection_ref: Some("c".to_string()),
                                inline_config: None,
                                title: None,
                                initial_command: None,
                            }],
                        },
                    ],
                },
                WorkspaceLayoutNode::Leaf {
                    tabs: vec![WorkspaceTabDef {
                        connection_ref: Some("d".to_string()),
                        inline_config: None,
                        title: None,
                        initial_command: None,
                    }],
                },
            ],
        };
        assert_eq!(count_tabs(&layout), 4);
    }

    #[test]
    fn serde_produces_correct_json_shape() {
        let ws = sample_workspace();
        let json: serde_json::Value = serde_json::to_value(&ws).unwrap();
        // Check camelCase renaming
        assert!(json.get("id").is_some());
        assert!(json.get("name").is_some());
        assert!(json.get("description").is_some());
        assert!(json.get("layout").is_some());
        // Check tagged enum format
        let layout = json.get("layout").unwrap();
        assert_eq!(layout.get("type").unwrap(), "split");
        assert!(layout.get("direction").is_some());
        assert!(layout.get("children").is_some());
    }

    #[test]
    fn description_omitted_when_none() {
        let ws = WorkspaceDefinition {
            id: "ws-2".to_string(),
            name: "Simple".to_string(),
            description: None,
            layout: WorkspaceLayoutNode::Leaf {
                tabs: vec![WorkspaceTabDef {
                    connection_ref: Some("conn-1".to_string()),
                    inline_config: None,
                    title: None,
                    initial_command: None,
                }],
            },
        };
        let json = serde_json::to_string(&ws).unwrap();
        assert!(!json.contains("description"));
    }
}
