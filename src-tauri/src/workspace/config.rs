use serde::{Deserialize, Serialize};

/// Reference to a remote agent connection definition.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRef {
    /// The remote agent's ID.
    pub agent_id: String,
    /// The definition ID on that agent.
    pub definition_id: String,
}

/// A tab definition within a workspace leaf panel.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTabDef {
    /// Reference to a saved connection by ID.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_ref: Option<String>,
    /// Inline connection config as fallback when no saved connection is referenced.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inline_config: Option<serde_json::Value>,
    /// Reference to a remote agent definition.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_ref: Option<AgentRef>,
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
        /// Optional percentage sizes for each child (must sum to 100, length must match children).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sizes: Option<Vec<f64>>,
    },
}

/// Split direction for layout containers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum SplitDirection {
    Horizontal,
    Vertical,
}

/// Definition of a single tab group within a workspace.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTabGroupDef {
    /// Display name for this tab group.
    pub name: String,
    /// Optional accent dot color (e.g. "#ff6b6b").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// The panel layout tree for this group.
    pub layout: WorkspaceLayoutNode,
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
    /// The tab groups in this workspace (always at least one).
    pub tab_groups: Vec<WorkspaceTabGroupDef>,
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
    /// Total number of tabs across all groups.
    pub connection_count: usize,
    /// Number of tab groups (omitted when 1 for clean display).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_count: Option<usize>,
}

impl WorkspaceDefinition {
    /// Create a summary for list display.
    pub fn to_summary(&self) -> WorkspaceSummary {
        let total_tabs: usize = self.tab_groups.iter().map(|g| count_tabs(&g.layout)).sum();
        let group_count = self.tab_groups.len();
        WorkspaceSummary {
            id: self.id.clone(),
            name: self.name.clone(),
            description: self.description.clone(),
            connection_count: total_tabs,
            group_count: if group_count > 1 {
                Some(group_count)
            } else {
                None
            },
        }
    }
}

/// Count the total number of tabs in a layout tree.
pub fn count_tabs(node: &WorkspaceLayoutNode) -> usize {
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

/// Export format for portable workspace definitions.
/// Connection IDs are replaced with connection names for portability.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceExportData {
    pub version: String,
    pub workspaces: Vec<WorkspaceExportEntry>,
}

/// A single workspace entry in the export format (no internal ID).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceExportEntry {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub tab_groups: Vec<WorkspaceTabGroupDef>,
}

/// Preview of a workspace import file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImportPreview {
    pub workspace_count: usize,
    pub total_tab_count: usize,
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

    fn sample_tab_group(name: &str, connection_ref: &str) -> WorkspaceTabGroupDef {
        WorkspaceTabGroupDef {
            name: name.to_string(),
            color: None,
            layout: WorkspaceLayoutNode::Leaf {
                tabs: vec![WorkspaceTabDef {
                    connection_ref: Some(connection_ref.to_string()),
                    inline_config: None,
                    agent_ref: None,
                    title: None,
                    initial_command: None,
                }],
            },
        }
    }

    fn sample_workspace() -> WorkspaceDefinition {
        WorkspaceDefinition {
            id: "ws-1".to_string(),
            name: "Dev Setup".to_string(),
            description: Some("My daily dev layout".to_string()),
            tab_groups: vec![
                WorkspaceTabGroupDef {
                    name: "Dev".to_string(),
                    color: None,
                    layout: WorkspaceLayoutNode::Split {
                        direction: SplitDirection::Horizontal,
                        children: vec![
                            WorkspaceLayoutNode::Leaf {
                                tabs: vec![WorkspaceTabDef {
                                    connection_ref: Some("conn-1".to_string()),
                                    inline_config: None,
                                    agent_ref: None,
                                    title: Some("Server".to_string()),
                                    initial_command: Some("cd /app && npm start".to_string()),
                                }],
                            },
                            WorkspaceLayoutNode::Leaf {
                                tabs: vec![
                                    WorkspaceTabDef {
                                        connection_ref: Some("conn-2".to_string()),
                                        inline_config: None,
                                        agent_ref: None,
                                        title: None,
                                        initial_command: None,
                                    },
                                    WorkspaceTabDef {
                                        connection_ref: None,
                                        inline_config: Some(serde_json::json!({
                                            "type": "local",
                                            "config": { "shell": "zsh" }
                                        })),
                                        agent_ref: None,
                                        title: Some("Local Shell".to_string()),
                                        initial_command: None,
                                    },
                                ],
                            },
                        ],
                        sizes: None,
                    },
                },
                sample_tab_group("Deploy", "conn-3"),
            ],
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
        assert_eq!(deserialized.tab_groups.len(), 2);
        assert_eq!(deserialized.tab_groups[0].name, "Dev");
        assert_eq!(deserialized.tab_groups[1].name, "Deploy");
    }

    #[test]
    fn workspace_layout_leaf_serde() {
        let leaf = WorkspaceLayoutNode::Leaf {
            tabs: vec![WorkspaceTabDef {
                connection_ref: Some("conn-1".to_string()),
                inline_config: None,
                agent_ref: None,
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
                        agent_ref: None,
                        title: None,
                        initial_command: None,
                    }],
                },
                WorkspaceLayoutNode::Leaf {
                    tabs: vec![WorkspaceTabDef {
                        connection_ref: Some("conn-2".to_string()),
                        inline_config: None,
                        agent_ref: None,
                        title: None,
                        initial_command: None,
                    }],
                },
            ],
            sizes: None,
        };
        let json = serde_json::to_string(&split).unwrap();
        let deserialized: WorkspaceLayoutNode = serde_json::from_str(&json).unwrap();
        if let WorkspaceLayoutNode::Split {
            direction,
            children,
            ..
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
            agent_ref: None,
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
            agent_ref: None,
            title: None,
            initial_command: None,
        };
        let json = serde_json::to_string(&tab).unwrap();
        assert!(!json.contains("inlineConfig"));
        assert!(!json.contains("agentRef"));
        assert!(!json.contains("title"));
        assert!(!json.contains("initialCommand"));
    }

    #[test]
    fn workspace_tab_def_agent_ref_round_trip() {
        let tab = WorkspaceTabDef {
            connection_ref: None,
            inline_config: None,
            agent_ref: Some(AgentRef {
                agent_id: "agent-1".to_string(),
                definition_id: "def-42".to_string(),
            }),
            title: Some("My Remote Shell".to_string()),
            initial_command: None,
        };
        let json = serde_json::to_string(&tab).unwrap();
        assert!(json.contains("agentRef"));
        assert!(json.contains("agentId"));
        assert!(json.contains("definitionId"));
        assert!(!json.contains("connectionRef"));
        let deserialized: WorkspaceTabDef = serde_json::from_str(&json).unwrap();
        let agent_ref = deserialized.agent_ref.unwrap();
        assert_eq!(agent_ref.agent_id, "agent-1");
        assert_eq!(agent_ref.definition_id, "def-42");
    }

    #[test]
    fn workspace_tab_def_agent_ref_omitted_when_none() {
        let tab = WorkspaceTabDef {
            connection_ref: Some("conn-1".to_string()),
            inline_config: None,
            agent_ref: None,
            title: None,
            initial_command: None,
        };
        let json = serde_json::to_string(&tab).unwrap();
        assert!(!json.contains("agentRef"));
    }

    #[test]
    fn workspace_summary_from_single_group() {
        let ws = WorkspaceDefinition {
            id: "ws-1".to_string(),
            name: "Simple".to_string(),
            description: None,
            tab_groups: vec![sample_tab_group("Main", "conn-1")],
        };
        let summary = ws.to_summary();
        assert_eq!(summary.id, "ws-1");
        assert_eq!(summary.name, "Simple");
        assert_eq!(summary.connection_count, 1);
        assert!(
            summary.group_count.is_none(),
            "group_count omitted for 1 group"
        );
    }

    #[test]
    fn workspace_summary_from_multi_group() {
        let ws = sample_workspace();
        let summary = ws.to_summary();
        assert_eq!(summary.id, "ws-1");
        assert_eq!(summary.connection_count, 4); // 1 + 2 + 1 tabs across groups
        assert_eq!(summary.group_count, Some(2));
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
                                    agent_ref: None,
                                    title: None,
                                    initial_command: None,
                                },
                                WorkspaceTabDef {
                                    connection_ref: Some("b".to_string()),
                                    inline_config: None,
                                    agent_ref: None,
                                    title: None,
                                    initial_command: None,
                                },
                            ],
                        },
                        WorkspaceLayoutNode::Leaf {
                            tabs: vec![WorkspaceTabDef {
                                connection_ref: Some("c".to_string()),
                                inline_config: None,
                                agent_ref: None,
                                title: None,
                                initial_command: None,
                            }],
                        },
                    ],
                    sizes: None,
                },
                WorkspaceLayoutNode::Leaf {
                    tabs: vec![WorkspaceTabDef {
                        connection_ref: Some("d".to_string()),
                        inline_config: None,
                        agent_ref: None,
                        title: None,
                        initial_command: None,
                    }],
                },
            ],
            sizes: None,
        };
        assert_eq!(count_tabs(&layout), 4);
    }

    #[test]
    fn serde_produces_correct_json_shape() {
        let ws = sample_workspace();
        let json: serde_json::Value = serde_json::to_value(&ws).unwrap();
        assert!(json.get("id").is_some());
        assert!(json.get("name").is_some());
        assert!(json.get("description").is_some());
        assert!(json.get("tabGroups").is_some(), "tabGroups field present");
        assert!(json.get("layout").is_none(), "old layout field absent");
        let groups = json.get("tabGroups").unwrap().as_array().unwrap();
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].get("name").unwrap(), "Dev");
    }

    #[test]
    fn description_omitted_when_none() {
        let ws = WorkspaceDefinition {
            id: "ws-2".to_string(),
            name: "Simple".to_string(),
            description: None,
            tab_groups: vec![sample_tab_group("Main", "conn-1")],
        };
        let json = serde_json::to_string(&ws).unwrap();
        assert!(!json.contains("description"));
    }

    #[test]
    fn tab_group_color_omitted_when_none() {
        let group = sample_tab_group("Main", "conn-1");
        let json = serde_json::to_string(&group).unwrap();
        assert!(!json.contains("color"));
    }

    #[test]
    fn tab_group_color_round_trips() {
        let group = WorkspaceTabGroupDef {
            name: "Dev".to_string(),
            color: Some("#ff6b6b".to_string()),
            layout: WorkspaceLayoutNode::Leaf { tabs: vec![] },
        };
        let json = serde_json::to_string(&group).unwrap();
        let deserialized: WorkspaceTabGroupDef = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.color.as_deref(), Some("#ff6b6b"));
    }

    #[test]
    fn split_with_sizes_serde_round_trip() {
        let split = WorkspaceLayoutNode::Split {
            direction: SplitDirection::Horizontal,
            children: vec![
                WorkspaceLayoutNode::Leaf {
                    tabs: vec![WorkspaceTabDef {
                        connection_ref: Some("conn-1".to_string()),
                        inline_config: None,
                        agent_ref: None,
                        title: None,
                        initial_command: None,
                    }],
                },
                WorkspaceLayoutNode::Leaf {
                    tabs: vec![WorkspaceTabDef {
                        connection_ref: Some("conn-2".to_string()),
                        inline_config: None,
                        agent_ref: None,
                        title: None,
                        initial_command: None,
                    }],
                },
            ],
            sizes: Some(vec![60.0, 40.0]),
        };
        let json = serde_json::to_string(&split).unwrap();
        assert!(json.contains("\"sizes\""));
        let deserialized: WorkspaceLayoutNode = serde_json::from_str(&json).unwrap();
        if let WorkspaceLayoutNode::Split { sizes, .. } = deserialized {
            assert_eq!(sizes, Some(vec![60.0, 40.0]));
        } else {
            panic!("Expected Split");
        }
    }

    #[test]
    fn split_without_sizes_serde_backward_compat() {
        let json =
            r#"{"type":"split","direction":"horizontal","children":[{"type":"leaf","tabs":[]}]}"#;
        let node: WorkspaceLayoutNode = serde_json::from_str(json).unwrap();
        if let WorkspaceLayoutNode::Split { sizes, .. } = node {
            assert_eq!(sizes, None);
        } else {
            panic!("Expected Split");
        }
    }

    #[test]
    fn split_sizes_omitted_when_none_in_json() {
        let split = WorkspaceLayoutNode::Split {
            direction: SplitDirection::Horizontal,
            children: vec![WorkspaceLayoutNode::Leaf { tabs: vec![] }],
            sizes: None,
        };
        let json = serde_json::to_string(&split).unwrap();
        assert!(!json.contains("sizes"));
    }
}
