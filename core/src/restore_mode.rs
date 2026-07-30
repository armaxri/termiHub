//! Startup session-restore decision logic (#2145).
//!
//! A faithful Rust twin of the frontend's `src/utils/restoreMode.ts`: pure
//! functions that decide how the previously-open tabs are handled on launch and
//! flatten / prune a stored last session for the restore dialog. There is no
//! DOM, store, or I/O here — every function maps saved-state + mode inputs to a
//! decision output.
//!
//! During the stateless-UI migration (#2139) the TypeScript version stays
//! authoritative; this port runs behind it and is proven equivalent via
//! golden-vector fixtures (`core/tests/fixtures/golden/restore_mode/`) extracted
//! from the TS suite, plus property tests over the pruning invariants.
//!
//! The only runtime dependency the TS module has,
//! [`get_workspace_leaves`] (from `workspaceLayout.ts`), is ported here as the
//! small leaf-walk helper it needs — route (a) of the issue's portability note,
//! rather than pulling in the whole 718-line `workspaceLayout.ts`.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

// ── Input types (mirror the TS type-only imports) ────────────────────────────

/// Minimal projection of `AppSettings` — only the two fields the restore-mode
/// decision reads. Unknown settings fields are ignored on deserialize.
///
/// `restore_last_session_mode` is kept as a raw `String` (not the
/// [`RestoreLastSessionMode`] enum) so an out-of-range persisted value falls
/// through to the default exactly as the TS `VALID_MODES.includes(...)` guard
/// does, instead of failing to deserialize.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// Explicit restore mode; wins when it is a valid mode string.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore_last_session_mode: Option<String>,
    /// Legacy boolean, migrated when the explicit mode is unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore_last_session_on_startup: Option<bool>,
}

/// Minimal projection of `SavedConnection` — the id used to resolve a
/// `connectionRef`, and its connection config.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SavedConnection {
    /// Stable connection id referenced by [`WorkspaceTabDef::connection_ref`].
    pub id: String,
    /// The connection's type + config.
    pub config: ConnectionConfig,
}

/// A connection config: a `type` discriminator plus an opaque config bag, matching
/// the frontend `ConnectionConfig`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ConnectionConfig {
    /// Connection type (`"ssh"`, `"serial"`, `"telnet"`, …).
    #[serde(rename = "type")]
    pub type_: String,
    /// Type-specific settings; read opaquely to derive probe targets.
    pub config: Value,
}

/// Inline connection config captured on a stored tab.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct InlineConfig {
    /// Connection type discriminator.
    #[serde(rename = "type")]
    pub type_: String,
    /// Type-specific settings bag.
    pub config: Value,
}

/// Reference to a remote agent definition on a stored tab.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRef {
    /// The agent the definition lives on.
    pub agent_id: String,
    /// The agent-side definition id.
    pub definition_id: String,
}

/// A tab definition within a workspace leaf panel.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTabDef {
    /// Reference to a saved connection by id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_ref: Option<String>,
    /// Inline config used when no saved connection is referenced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inline_config: Option<InlineConfig>,
    /// Reference to a remote agent definition.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_ref: Option<AgentRef>,
    /// Optional tab title override.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Optional command to run after the session connects.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_command: Option<String>,
}

/// A leaf panel holding one or more tabs.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct WorkspaceLeafNode {
    /// The tabs in this leaf, in display order.
    pub tabs: Vec<WorkspaceTabDef>,
}

/// Split direction for a container node.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SplitDirection {
    /// Children are laid out left-to-right.
    Horizontal,
    /// Children are laid out top-to-bottom.
    Vertical,
}

/// A split container with child panels.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct WorkspaceSplitNode {
    /// Split axis.
    pub direction: SplitDirection,
    /// Child layout nodes.
    pub children: Vec<WorkspaceLayoutNode>,
    /// Optional percentage sizes per child (sums to 100, matches `children`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sizes: Option<Vec<f64>>,
}

/// Recursive layout tree for a workspace tab group, serializing to the same
/// `{ "type": "leaf" | "split", … }` discriminated union as the TS side.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum WorkspaceLayoutNode {
    /// A leaf panel.
    Leaf(WorkspaceLeafNode),
    /// A split container.
    Split(WorkspaceSplitNode),
}

/// A single tab group within a session (name + panel layout tree).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTabGroupDef {
    /// Display name for the group.
    pub name: String,
    /// Optional accent dot color.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// The panel layout tree.
    pub layout: WorkspaceLayoutNode,
    /// Logical id of the window this group belongs to (#1905).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_id: Option<String>,
}

/// A native window recorded in a saved session (#1905). Preserved untouched by
/// [`filter_session_by_selection`], so it carries every field opaquely.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct WorkspaceWindowDef {
    /// Logical window id referenced by tab groups.
    pub id: String,
}

/// The automatically persisted "last session".
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LastSession {
    /// Schema version for forward compatibility.
    pub version: String,
    /// The captured tab groups (panel trees) of the session.
    pub tab_groups: Vec<WorkspaceTabGroupDef>,
    /// Index into `tab_groups` of the group that was active.
    pub active_group_index: i64,
    /// The windows the session spanned, in restore order (#1905).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub windows: Option<Vec<WorkspaceWindowDef>>,
}

// ── Output types ─────────────────────────────────────────────────────────────

/// The three restore modes.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RestoreLastSessionMode {
    /// Never restore; start with a fresh empty session.
    Never,
    /// Show a dialog offering to restore the previous session.
    Ask,
    /// Restore the previous session silently.
    Always,
}

/// How a stored tab connects, selecting the reachability check to run.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TargetKind {
    /// TCP host target (SSH/telnet) — network-probed.
    Host,
    /// Serial device target — device-presence probed.
    Serial,
    /// Local/docker/WSL/unresolved — not network-probed.
    Local,
    /// Remote agent target — not network-probed.
    Agent,
}

/// The connection target derived from a stored tab, driving the reachability probe.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RestoreTabTarget {
    /// How the tab connects.
    pub kind: TargetKind,
    /// Target host for `host` targets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    /// Target TCP port for `host` targets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<i64>,
    /// Serial device path for `serial` targets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    /// Remote agent id for `agent` targets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
}

/// A single restorable tab, described for the restore dialog.
///
/// `reachability` / `unreachable_reason` are set asynchronously by the probe,
/// never by [`summarize_last_session`], so they are absent in this port's output
/// (matching the TS summary output shape exactly).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RestoreTabInfo {
    /// Human-readable tab title.
    pub title: String,
    /// Short connection-type label (e.g. "SSH", "Serial", "Local").
    pub type_label: String,
    /// The probe target derived from the stored tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<RestoreTabTarget>,
    /// Reachability of `target`, set once the probe resolves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reachability: Option<String>,
    /// Reason shown beside the warning icon when unreachable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unreachable_reason: Option<String>,
}

/// Summary of a stored last session for the restore dialog.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RestorePrompt {
    /// Total number of restorable tabs across all groups.
    pub tab_count: usize,
    /// Per-tab descriptors for display.
    pub tabs: Vec<RestoreTabInfo>,
}

// ── Public API ───────────────────────────────────────────────────────────────

/// Get all leaf nodes from a workspace layout tree, depth-first left-to-right.
///
/// Rust twin of `getWorkspaceLeaves` from `workspaceLayout.ts`, the one runtime
/// dependency `restoreMode.ts` has. Ported here (rather than the whole
/// `workspaceLayout.ts`) because the restore logic only needs the leaf walk.
pub fn get_workspace_leaves(node: &WorkspaceLayoutNode) -> Vec<&WorkspaceLeafNode> {
    match node {
        WorkspaceLayoutNode::Leaf(leaf) => vec![leaf],
        WorkspaceLayoutNode::Split(split) => split
            .children
            .iter()
            .flat_map(get_workspace_leaves)
            .collect(),
    }
}

/// Resolve the effective restore mode from settings, migrating the legacy
/// boolean `restore_last_session_on_startup` when the explicit mode is unset.
///
/// - explicit [`AppSettings::restore_last_session_mode`] wins when valid;
/// - otherwise the legacy boolean `== false` maps to `Never`;
/// - otherwise the default is `Ask`.
pub fn resolve_restore_mode(settings: &AppSettings) -> RestoreLastSessionMode {
    if let Some(explicit) = settings.restore_last_session_mode.as_deref() {
        match explicit {
            "never" => return RestoreLastSessionMode::Never,
            "ask" => return RestoreLastSessionMode::Ask,
            "always" => return RestoreLastSessionMode::Always,
            _ => {}
        }
    }
    if settings.restore_last_session_on_startup == Some(false) {
        return RestoreLastSessionMode::Never;
    }
    RestoreLastSessionMode::Ask
}

/// Default TCP ports for host-based connection types, used when unspecified.
fn default_host_port(type_: &str) -> Option<i64> {
    match type_ {
        "ssh" => Some(22),
        "telnet" => Some(23),
        _ => None,
    }
}

/// Map a stored tab definition's connection type to a short display label.
fn tab_type_label(tab: &WorkspaceTabDef) -> String {
    if tab.agent_ref.is_some() {
        return "Agent".to_string();
    }
    let type_ = tab.inline_config.as_ref().map(|c| c.type_.as_str());
    match type_ {
        Some("ssh") => "SSH".to_string(),
        Some("serial") => "Serial".to_string(),
        Some("telnet") => "Telnet".to_string(),
        Some("docker") => "Docker".to_string(),
        Some("wsl") => "WSL".to_string(),
        Some("local") => "Local".to_string(),
        Some(t) if !t.is_empty() => capitalize_first(t),
        _ => "Terminal".to_string(),
    }
}

/// Uppercase the first character, mirroring TS `s.charAt(0).toUpperCase() + s.slice(1)`.
fn capitalize_first(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// Read a string field from a JSON config bag.
fn config_str<'a>(config: &'a Value, key: &str) -> Option<&'a str> {
    config.get(key).and_then(Value::as_str)
}

/// Best-effort title for a stored tab when no explicit title was captured.
fn tab_fallback_title(tab: &WorkspaceTabDef) -> String {
    let cfg = tab.inline_config.as_ref().map(|c| &c.config);
    if let Some(cfg) = cfg {
        if let Some(host) = config_str(cfg, "host") {
            return match config_str(cfg, "username") {
                Some(user) => format!("{user}@{host}"),
                None => host.to_string(),
            };
        }
        if let Some(device) = config_str(cfg, "device") {
            return device.to_string();
        }
    }
    tab_type_label(tab)
}

/// Resolve a stored tab's effective `(type, config)`, following a
/// `connection_ref` into the supplied saved connections when present.
fn resolve_tab_config<'a>(
    tab: &'a WorkspaceTabDef,
    connections: &'a [SavedConnection],
) -> Option<(&'a str, &'a Value)> {
    if let Some(inline) = &tab.inline_config {
        return Some((inline.type_.as_str(), &inline.config));
    }
    if let Some(ref_id) = &tab.connection_ref {
        if let Some(saved) = connections.iter().find(|c| &c.id == ref_id) {
            return Some((saved.config.type_.as_str(), &saved.config.config));
        }
    }
    None
}

/// Derive the reachability [`RestoreTabTarget`] for a stored tab.
fn derive_tab_target(tab: &WorkspaceTabDef, connections: &[SavedConnection]) -> RestoreTabTarget {
    if let Some(agent) = &tab.agent_ref {
        return RestoreTabTarget {
            kind: TargetKind::Agent,
            host: None,
            port: None,
            device: None,
            agent_id: Some(agent.agent_id.clone()),
        };
    }

    let resolved = resolve_tab_config(tab, connections);
    let type_ = resolved.map(|(t, _)| t);
    let empty = Value::Null;
    let config = resolved.map(|(_, c)| c).unwrap_or(&empty);

    if type_ == Some("ssh") || type_ == Some("telnet") {
        if let Some(host) = config_str(config, "host") {
            let port = config
                .get("port")
                .and_then(Value::as_i64)
                .or_else(|| default_host_port(type_.unwrap_or("")));
            return RestoreTabTarget {
                kind: TargetKind::Host,
                host: Some(host.to_string()),
                port,
                device: None,
                agent_id: None,
            };
        }
    }

    if type_ == Some("serial") {
        let device = config_str(config, "device").or_else(|| config_str(config, "port"));
        if let Some(device) = device {
            return RestoreTabTarget {
                kind: TargetKind::Serial,
                host: None,
                port: None,
                device: Some(device.to_string()),
                agent_id: None,
            };
        }
    }

    RestoreTabTarget {
        kind: TargetKind::Local,
        host: None,
        port: None,
        device: None,
        agent_id: None,
    }
}

/// Flatten a stored [`LastSession`] into a per-tab summary for the restore
/// dialog. Iterates groups → leaves → tabs in a stable order; that same order is
/// the tab index space used by [`filter_session_by_selection`].
pub fn summarize_last_session(
    session: &LastSession,
    connections: &[SavedConnection],
) -> RestorePrompt {
    let mut tabs: Vec<RestoreTabInfo> = Vec::new();
    for group in &session.tab_groups {
        for leaf in get_workspace_leaves(&group.layout) {
            for tab in &leaf.tabs {
                let title = tab
                    .title
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| tab_fallback_title(tab));
                tabs.push(RestoreTabInfo {
                    title,
                    type_label: tab_type_label(tab),
                    target: Some(derive_tab_target(tab, connections)),
                    reachability: None,
                    unreachable_reason: None,
                });
            }
        }
    }
    RestorePrompt {
        tab_count: tabs.len(),
        tabs,
    }
}

/// Prune one layout node down to the selected tabs, advancing the flat tab index
/// counter. Returns `None` when the node (and every descendant) is emptied.
fn filter_node(
    node: &WorkspaceLayoutNode,
    selected: &HashSet<i64>,
    flat_index: &mut i64,
) -> Option<WorkspaceLayoutNode> {
    match node {
        WorkspaceLayoutNode::Leaf(leaf) => {
            let tabs: Vec<WorkspaceTabDef> = leaf
                .tabs
                .iter()
                .filter(|_| {
                    let i = *flat_index;
                    *flat_index += 1;
                    selected.contains(&i)
                })
                .cloned()
                .collect();
            if tabs.is_empty() {
                None
            } else {
                Some(WorkspaceLayoutNode::Leaf(WorkspaceLeafNode { tabs }))
            }
        }
        WorkspaceLayoutNode::Split(split) => {
            let mut kept_children: Vec<WorkspaceLayoutNode> = Vec::new();
            let mut kept_original_indices: Vec<usize> = Vec::new();
            for (i, child) in split.children.iter().enumerate() {
                if let Some(filtered) = filter_node(child, selected, flat_index) {
                    kept_children.push(filtered);
                    kept_original_indices.push(i);
                }
            }

            if kept_children.is_empty() {
                return None;
            }
            if kept_children.len() == 1 {
                return kept_children.into_iter().next();
            }

            let sizes = split.sizes.as_ref().and_then(|sizes| {
                let chosen: Vec<f64> = kept_original_indices
                    .iter()
                    .map(|&i| sizes.get(i).copied().unwrap_or(0.0))
                    .collect();
                let total: f64 = chosen.iter().sum();
                if total > 0.0 {
                    Some(chosen.iter().map(|s| (s / total) * 100.0).collect())
                } else {
                    None
                }
            });

            Some(WorkspaceLayoutNode::Split(WorkspaceSplitNode {
                direction: split.direction,
                children: kept_children,
                sizes,
            }))
        }
    }
}

/// Prune a stored [`LastSession`] down to the tabs the user chose to restore.
///
/// `selected` holds the flat tab indices to keep, in the same order
/// [`summarize_last_session`] produced. Leaves left with no tabs are dropped,
/// splits collapse when only one child survives (redistributing sizes), and tab
/// groups whose layout empties out are removed. `active_group_index` is remapped
/// to the surviving group nearest the original active one; `windows` are
/// preserved untouched (an emptied window still round-trips, per #1902).
pub fn filter_session_by_selection(session: &LastSession, selected: &HashSet<i64>) -> LastSession {
    let mut flat_index = 0i64;

    let mut groups: Vec<WorkspaceTabGroupDef> = Vec::new();
    let mut kept_group_indices: Vec<i64> = Vec::new();
    for (i, group) in session.tab_groups.iter().enumerate() {
        if let Some(layout) = filter_node(&group.layout, selected, &mut flat_index) {
            groups.push(WorkspaceTabGroupDef {
                layout,
                ..group.clone()
            });
            kept_group_indices.push(i as i64);
        }
    }

    // Remap the active group to a surviving one: the same group if it survived,
    // otherwise the nearest surviving group at or after it, else the first.
    let mut active_group_index = 0i64;
    if !kept_group_indices.is_empty() {
        if let Some(exact) = kept_group_indices
            .iter()
            .position(|&i| i == session.active_group_index)
        {
            active_group_index = exact as i64;
        } else if let Some(after) = kept_group_indices
            .iter()
            .position(|&i| i >= session.active_group_index)
        {
            active_group_index = after as i64;
        } else {
            active_group_index = (kept_group_indices.len() - 1) as i64;
        }
    }

    LastSession {
        tab_groups: groups,
        active_group_index,
        ..session.clone()
    }
}

#[cfg(test)]
mod tests;
