//! The authoritative, client-scoped layout model behind the shadow
//! `layout@<clientId>` projection region (#2151, widened for #2283 slice A).
//!
//! Every structural transform delegates to the pure panel-tree algebra ported in
//! #2143 (`termihub_core::layout::panel_tree`) — this module owns the per-client
//! authoritative **multi-group** model and turns the `layout.*` intents into
//! algebra calls. It holds the tab-group set (each with its own panel tree) plus
//! the minimal tab model (`{ id, sessionId, contentType }`, exactly the seam the
//! ported `Tab` model exposes); session status, tab colours, and broadcast
//! membership stay in `appStore` under partial projection and migrate in later
//! phases.
//!
//! # Multi-group authority + back-compat view (#2283 slice A)
//!
//! The store is now authoritative for the **full** layout: the ordered set of
//! tab groups (`{ id, name, color, root, activePanelId }`) plus the active group.
//! [`LayoutStore::snapshot_full`] emits `{ activeGroupId, groups: [...] }`. To
//! keep the current render path unaffected until a later slice flips the
//! frontend, [`LayoutStore::snapshot`] still emits the **active group's**
//! back-compat view `{ root, activePanelId }` — the shape every existing
//! `layout@<clientId>` consumer renders. Every structural transform takes an
//! optional `group_id`, resolving to the active group when omitted.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use termihub_core::layout::panel_tree::{
    create_leaf_panel, edge_to_split, find_leaf, find_leaf_by_tab, generate_panel_id,
    get_all_leaves, normalize_sizes, remove_leaf, simplify_tree, split_leaf, update_leaf,
    Direction, DropEdge, LeafPanel, PanelNode, Position, SplitContainer, Tab,
};

/// A rejectable layout-intent failure. Maps to an intent ack `(code, message)`
/// in [`super::projection`].
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum LayoutError {
    /// A referenced leaf panel id is not present in the target group's tree.
    #[error("panel not found: {0}")]
    PanelNotFound(String),
    /// A referenced tab id is not present in the target group's tree.
    #[error("tab not found: {0}")]
    TabNotFound(String),
    /// A referenced tab group id is not present in the client's layout.
    #[error("group not found: {0}")]
    GroupNotFound(String),
    /// `closeGroup` was asked to close the sole remaining group — the app always
    /// keeps at least one group, so this is rejected rather than silently no-op.
    #[error("cannot close the last remaining group")]
    LastGroup,
    /// A `moveTab` used the `center` edge where a real split edge was required,
    /// or vice versa — a malformed payload.
    #[error("invalid split edge")]
    BadEdge,
    /// `merge` was asked to merge a panel into itself.
    #[error("source and target panels are the same")]
    SamePanel,
    /// A `reorderTabs` / `reorderGroups` index fell outside the valid range.
    #[error("index out of range")]
    IndexOutOfRange,
    /// A `resize` supplied a size array whose length did not match the split's
    /// child count.
    #[error("size count does not match the split's children")]
    SizeMismatch,
}

impl LayoutError {
    /// The stable intent-ack error code for this failure.
    pub fn code(&self) -> &'static str {
        match self {
            LayoutError::PanelNotFound(_) => "panel_not_found",
            LayoutError::TabNotFound(_) => "tab_not_found",
            LayoutError::GroupNotFound(_) => "group_not_found",
            LayoutError::LastGroup => "last_group",
            LayoutError::BadEdge
            | LayoutError::SamePanel
            | LayoutError::IndexOutOfRange
            | LayoutError::SizeMismatch => "bad_payload",
        }
    }
}

/// One tab group: an independent panel tree plus its metadata and focused panel.
/// Serialises to the frontend `TabGroup` shape (`{ id, name, color?, root,
/// activePanelId }`) — `color` is omitted when unset.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupLayout {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub root: PanelNode,
    #[serde(default)]
    pub active_panel_id: Option<String>,
}

impl GroupLayout {
    /// A freshly-seeded group: a single empty leaf panel, focused.
    fn seeded(name: impl Into<String>) -> Self {
        let leaf = create_leaf_panel();
        let id = leaf.id.clone();
        Self {
            id: generate_group_id(),
            name: name.into(),
            color: None,
            root: PanelNode::Leaf(leaf),
            active_panel_id: Some(id),
        }
    }
}

/// One client's authoritative layout: its ordered tab groups plus the active
/// group. Serialises to the full multi-group view `{ groups, activeGroupId }`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientLayout {
    pub groups: Vec<GroupLayout>,
    pub active_group_id: String,
}

impl ClientLayout {
    /// A freshly-seeded client: one "Main" group with a single empty focused leaf.
    fn seeded() -> Self {
        let group = GroupLayout::seeded("Main");
        let active_group_id = group.id.clone();
        Self {
            groups: vec![group],
            active_group_id,
        }
    }

    /// The full render-ready view model: `{ activeGroupId, groups: [...] }`.
    ///
    /// The authoritative shape a later slice flips the region and frontend onto;
    /// not yet consumed by production wiring this slice (only [`snapshot_full`]).
    #[allow(dead_code)]
    fn full_view(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }

    /// The back-compat **active-group** view `{ root, activePanelId }` — the shape
    /// the current `layout@<clientId>` consumers render, unchanged by the widening
    /// so the live render path is unaffected until a later slice.
    fn active_view(&self) -> Value {
        match self.active_group() {
            Some(g) => json!({ "root": g.root, "activePanelId": g.active_panel_id }),
            None => json!({ "root": PanelNode::Leaf(create_leaf_panel()), "activePanelId": null }),
        }
    }

    /// The active group, falling back to the first group when the active id is
    /// somehow dangling (should not happen — transforms keep it valid).
    fn active_group(&self) -> Option<&GroupLayout> {
        self.groups
            .iter()
            .find(|g| g.id == self.active_group_id)
            .or_else(|| self.groups.first())
    }

    /// A mutable borrow of the group `group_id` names, or the active group when
    /// `group_id` is `None`. Rejects an unknown group.
    fn group_mut(&mut self, group_id: Option<&str>) -> Result<&mut GroupLayout, LayoutError> {
        let gid = group_id
            .map(str::to_string)
            .unwrap_or_else(|| self.active_group_id.clone());
        self.groups
            .iter_mut()
            .find(|g| g.id == gid)
            .ok_or(LayoutError::GroupNotFound(gid))
    }
}

/// The shadow layout authority. Owns one [`ClientLayout`] per attached client,
/// keyed by `clientId`; an unknown client is seeded lazily on first touch.
#[derive(Default)]
pub struct LayoutStore {
    clients: Mutex<HashMap<String, ClientLayout>>,
}

impl LayoutStore {
    /// A store with no clients yet. Clients are seeded lazily per `clientId`.
    pub fn new() -> Self {
        Self::default()
    }

    /// The current **back-compat** render-ready view for a client (seeding it if
    /// unknown): the active group's `{ root, activePanelId }`.
    ///
    /// Pure with respect to layout structure — it never mutates an existing
    /// client — so the projector can safely diff two consecutive snapshots. This
    /// keeps the live `layout@<clientId>` region shape unchanged this slice.
    pub fn snapshot(&self, client_id: &str) -> Value {
        self.lock()
            .entry(client_id.to_string())
            .or_insert_with(ClientLayout::seeded)
            .active_view()
    }

    /// The full multi-group view for a client: `{ activeGroupId, groups: [...] }`.
    /// The authoritative shape a later slice flips the region and frontend onto;
    /// exercised by the group-transform tests this slice, not yet by live wiring.
    #[allow(dead_code)]
    pub fn snapshot_full(&self, client_id: &str) -> Value {
        self.lock()
            .entry(client_id.to_string())
            .or_insert_with(ClientLayout::seeded)
            .full_view()
    }

    /// `layout.split` — split a leaf panel, inserting a new empty leaf beside it
    /// and focusing the new leaf.
    pub fn split(
        &self,
        client_id: &str,
        group_id: Option<&str>,
        panel_id: &str,
        direction: Direction,
        position: Position,
    ) -> Result<(), LayoutError> {
        let mut clients = self.lock();
        let group = clients
            .entry(client_id.to_string())
            .or_insert_with(ClientLayout::seeded)
            .group_mut(group_id)?;
        if find_leaf(&group.root, panel_id).is_none() {
            return Err(LayoutError::PanelNotFound(panel_id.to_string()));
        }
        let new_leaf = create_leaf_panel();
        let new_id = new_leaf.id.clone();
        group.root = split_leaf(&group.root, panel_id, &new_leaf, direction, position);
        group.active_panel_id = Some(new_id);
        fix_active(group);
        Ok(())
    }

    /// `layout.merge` — move every tab of `source_panel_id` into
    /// `target_panel_id`, drop the now-empty source panel, and simplify.
    pub fn merge(
        &self,
        client_id: &str,
        group_id: Option<&str>,
        source_panel_id: &str,
        target_panel_id: &str,
    ) -> Result<(), LayoutError> {
        if source_panel_id == target_panel_id {
            return Err(LayoutError::SamePanel);
        }
        let mut clients = self.lock();
        let group = clients
            .entry(client_id.to_string())
            .or_insert_with(ClientLayout::seeded)
            .group_mut(group_id)?;
        let tabs = find_leaf(&group.root, source_panel_id)
            .ok_or_else(|| LayoutError::PanelNotFound(source_panel_id.to_string()))?
            .tabs
            .clone();
        if find_leaf(&group.root, target_panel_id).is_none() {
            return Err(LayoutError::PanelNotFound(target_panel_id.to_string()));
        }
        let merged = update_leaf(&group.root, target_panel_id, |leaf| {
            with_tabs_appended(leaf, &tabs)
        });
        let pruned = remove_leaf(&merged, source_panel_id).unwrap_or_else(single_empty_leaf);
        group.root = simplify_tree(&pruned);
        group.active_panel_id = Some(target_panel_id.to_string());
        fix_active(group);
        Ok(())
    }

    /// `layout.moveTab` — move a tab to a target panel. A `center` edge drops it
    /// into the target's tab stack (a merge); any other edge splits the target
    /// and places the tab in the new leaf. The source panel is pruned if it is
    /// left empty.
    pub fn move_tab(
        &self,
        client_id: &str,
        group_id: Option<&str>,
        tab_id: &str,
        target_panel_id: &str,
        edge: DropEdge,
    ) -> Result<(), LayoutError> {
        let mut clients = self.lock();
        let group = clients
            .entry(client_id.to_string())
            .or_insert_with(ClientLayout::seeded)
            .group_mut(group_id)?;
        let source_leaf = find_leaf_by_tab(&group.root, tab_id)
            .ok_or_else(|| LayoutError::TabNotFound(tab_id.to_string()))?;
        let source_id = source_leaf.id.clone();
        let tab = source_leaf
            .tabs
            .iter()
            .find(|t| t.id == tab_id)
            .cloned()
            .ok_or_else(|| LayoutError::TabNotFound(tab_id.to_string()))?;
        if find_leaf(&group.root, target_panel_id).is_none() {
            return Err(LayoutError::PanelNotFound(target_panel_id.to_string()));
        }

        let detached = update_leaf(&group.root, &source_id, |leaf| {
            with_tab_removed(leaf, tab_id)
        });
        let placed = match edge {
            DropEdge::Center => update_leaf(&detached, target_panel_id, |leaf| {
                with_tab_added(leaf, tab.clone())
            }),
            edge => {
                let spec = edge_to_split(edge).ok_or(LayoutError::BadEdge)?;
                let new_leaf = LeafPanel {
                    id: generate_panel_id(),
                    tabs: vec![tab.clone()],
                    active_tab_id: Some(tab.id.clone()),
                };
                split_leaf(
                    &detached,
                    target_panel_id,
                    &new_leaf,
                    spec.direction,
                    spec.position,
                )
            }
        };
        let pruned = remove_leaf_if_empty(&placed, &source_id);
        group.root = simplify_tree(&pruned);
        fix_active(group);
        Ok(())
    }

    /// `layout.closeTabStructure` — remove a tab from the tree, dropping its leaf
    /// if it becomes empty. Only the structural half of closing a tab; session
    /// teardown stays in `appStore` under partial projection (later phases).
    pub fn close_tab_structure(
        &self,
        client_id: &str,
        group_id: Option<&str>,
        tab_id: &str,
    ) -> Result<(), LayoutError> {
        let mut clients = self.lock();
        let group = clients
            .entry(client_id.to_string())
            .or_insert_with(ClientLayout::seeded)
            .group_mut(group_id)?;
        let leaf_id = find_leaf_by_tab(&group.root, tab_id)
            .ok_or_else(|| LayoutError::TabNotFound(tab_id.to_string()))?
            .id
            .clone();
        let detached = update_leaf(&group.root, &leaf_id, |leaf| with_tab_removed(leaf, tab_id));
        let pruned = remove_leaf_if_empty(&detached, &leaf_id);
        group.root = simplify_tree(&pruned);
        fix_active(group);
        Ok(())
    }

    /// `layout.addTab` — insert a minimal tab into `(group, panel)` and focus it.
    /// The structural half of opening a tab; the frontend session-creation flow
    /// supplies the tab identity (`{ id, sessionId, contentType }`). Rejects an
    /// unknown panel.
    pub fn add_tab(
        &self,
        client_id: &str,
        group_id: Option<&str>,
        panel_id: &str,
        tab: Tab,
    ) -> Result<(), LayoutError> {
        let mut clients = self.lock();
        let group = clients
            .entry(client_id.to_string())
            .or_insert_with(ClientLayout::seeded)
            .group_mut(group_id)?;
        if find_leaf(&group.root, panel_id).is_none() {
            return Err(LayoutError::PanelNotFound(panel_id.to_string()));
        }
        group.root = update_leaf(&group.root, panel_id, |leaf| {
            with_tab_added(leaf, tab.clone())
        });
        group.active_panel_id = Some(panel_id.to_string());
        Ok(())
    }

    /// `layout.removePanel` — drop a whole leaf panel (and every tab it holds)
    /// from the tree, then simplify and repoint focus. The structural half of the
    /// close-panel action. Removing the sole remaining leaf is a no-op — the app
    /// always keeps at least one panel — mirroring the frontend `removePanel`
    /// reducer's `allLeaves.length <= 1` guard.
    pub fn remove_panel(
        &self,
        client_id: &str,
        group_id: Option<&str>,
        panel_id: &str,
    ) -> Result<(), LayoutError> {
        let mut clients = self.lock();
        let group = clients
            .entry(client_id.to_string())
            .or_insert_with(ClientLayout::seeded)
            .group_mut(group_id)?;
        if find_leaf(&group.root, panel_id).is_none() {
            return Err(LayoutError::PanelNotFound(panel_id.to_string()));
        }
        if get_all_leaves(&group.root).len() <= 1 {
            // Sole leaf: the frontend leaves the tree untouched; match it.
            return Ok(());
        }
        let removed = remove_leaf(&group.root, panel_id).unwrap_or_else(single_empty_leaf);
        group.root = simplify_tree(&removed);
        fix_active(group);
        Ok(())
    }

    /// `layout.reorderTabs` — move a tab within a single leaf from `old_index` to
    /// `new_index`, leaving the active tab and every other panel untouched.
    pub fn reorder_tabs(
        &self,
        client_id: &str,
        group_id: Option<&str>,
        panel_id: &str,
        old_index: usize,
        new_index: usize,
    ) -> Result<(), LayoutError> {
        let mut clients = self.lock();
        let group = clients
            .entry(client_id.to_string())
            .or_insert_with(ClientLayout::seeded)
            .group_mut(group_id)?;
        let leaf = find_leaf(&group.root, panel_id)
            .ok_or_else(|| LayoutError::PanelNotFound(panel_id.to_string()))?;
        let len = leaf.tabs.len();
        if old_index >= len || new_index >= len {
            return Err(LayoutError::IndexOutOfRange);
        }
        group.root = update_leaf(&group.root, panel_id, |leaf| {
            with_tabs_reordered(leaf, old_index, new_index)
        });
        Ok(())
    }

    /// `layout.setActivePanel` — repoint the focused panel within a group.
    pub fn set_active_panel(
        &self,
        client_id: &str,
        group_id: Option<&str>,
        panel_id: &str,
    ) -> Result<(), LayoutError> {
        let mut clients = self.lock();
        let group = clients
            .entry(client_id.to_string())
            .or_insert_with(ClientLayout::seeded)
            .group_mut(group_id)?;
        if find_leaf(&group.root, panel_id).is_none() {
            return Err(LayoutError::PanelNotFound(panel_id.to_string()));
        }
        group.active_panel_id = Some(panel_id.to_string());
        Ok(())
    }

    /// `layout.resize` — persist the child percentage `sizes` of the split
    /// container `split_id` (normalized to sum to 100). Rejects a size array whose
    /// length does not match the split's child count.
    pub fn resize(
        &self,
        client_id: &str,
        group_id: Option<&str>,
        split_id: &str,
        sizes: Vec<f64>,
    ) -> Result<(), LayoutError> {
        let mut clients = self.lock();
        let group = clients
            .entry(client_id.to_string())
            .or_insert_with(ClientLayout::seeded)
            .group_mut(group_id)?;
        let split = find_split(&group.root, split_id)
            .ok_or_else(|| LayoutError::PanelNotFound(split_id.to_string()))?;
        if sizes.len() != split.children.len() {
            return Err(LayoutError::SizeMismatch);
        }
        let normalized = normalize_sizes(&sizes);
        group.root = set_split_sizes(&group.root, split_id, &normalized);
        Ok(())
    }

    // ── Group-level transforms (twins of the frontend `*TabGroup*` reducers) ──

    /// `layout.addGroup` — append a fresh empty group and make it active. Returns
    /// the new group's id. Mirrors the frontend `addTabGroup` reducer's default
    /// `Group {count}` naming when no `name` is supplied.
    pub fn add_group(&self, client_id: &str, name: Option<String>) -> String {
        let mut clients = self.lock();
        let client = clients
            .entry(client_id.to_string())
            .or_insert_with(ClientLayout::seeded);
        let count = client.groups.len() + 1;
        let group = GroupLayout::seeded(name.unwrap_or_else(|| format!("Group {count}")));
        let new_id = group.id.clone();
        client.groups.push(group);
        client.active_group_id = new_id.clone();
        new_id
    }

    /// `layout.closeGroup` — remove a group. Closing the sole remaining group is
    /// rejected ([`LayoutError::LastGroup`]) — the app always keeps one group.
    /// Closing the active group repoints the active group onto the adjacent one
    /// (`max(0, idx-1)`), matching the frontend `closeTabGroup` reducer.
    pub fn close_group(&self, client_id: &str, group_id: &str) -> Result<(), LayoutError> {
        let mut clients = self.lock();
        let client = clients
            .entry(client_id.to_string())
            .or_insert_with(ClientLayout::seeded);
        if client.groups.len() <= 1 {
            return Err(LayoutError::LastGroup);
        }
        let idx = client
            .groups
            .iter()
            .position(|g| g.id == group_id)
            .ok_or_else(|| LayoutError::GroupNotFound(group_id.to_string()))?;
        let was_active = client.active_group_id == group_id;
        client.groups.remove(idx);
        if was_active {
            let new_idx = idx.saturating_sub(1).min(client.groups.len() - 1);
            client.active_group_id = client.groups[new_idx].id.clone();
        }
        Ok(())
    }

    /// `layout.renameGroup` — set a group's display name.
    pub fn rename_group(
        &self,
        client_id: &str,
        group_id: &str,
        name: String,
    ) -> Result<(), LayoutError> {
        let mut clients = self.lock();
        let group = clients
            .entry(client_id.to_string())
            .or_insert_with(ClientLayout::seeded)
            .group_mut(Some(group_id))?;
        group.name = name;
        Ok(())
    }

    /// `layout.setGroupColor` — set (or clear, with `None`) a group's accent
    /// colour.
    pub fn set_group_color(
        &self,
        client_id: &str,
        group_id: &str,
        color: Option<String>,
    ) -> Result<(), LayoutError> {
        let mut clients = self.lock();
        let group = clients
            .entry(client_id.to_string())
            .or_insert_with(ClientLayout::seeded)
            .group_mut(Some(group_id))?;
        group.color = color;
        Ok(())
    }

    /// `layout.setActiveGroup` — switch the active group.
    pub fn set_active_group(&self, client_id: &str, group_id: &str) -> Result<(), LayoutError> {
        let mut clients = self.lock();
        let client = clients
            .entry(client_id.to_string())
            .or_insert_with(ClientLayout::seeded);
        if !client.groups.iter().any(|g| g.id == group_id) {
            return Err(LayoutError::GroupNotFound(group_id.to_string()));
        }
        client.active_group_id = group_id.to_string();
        Ok(())
    }

    /// `layout.reorderGroups` — move a group from `from_index` to `to_index`
    /// (splice-out-then-splice-in), matching the frontend `reorderTabGroups`.
    pub fn reorder_groups(
        &self,
        client_id: &str,
        from_index: usize,
        to_index: usize,
    ) -> Result<(), LayoutError> {
        let mut clients = self.lock();
        let client = clients
            .entry(client_id.to_string())
            .or_insert_with(ClientLayout::seeded);
        let len = client.groups.len();
        if from_index >= len || to_index >= len {
            return Err(LayoutError::IndexOutOfRange);
        }
        let moved = client.groups.remove(from_index);
        client.groups.insert(to_index, moved);
        Ok(())
    }

    /// `layout.moveTabToGroup` — move a tab from a panel in the **active** group
    /// into the target group's first leaf, focusing it there. Prunes the emptied
    /// source panel (unless it is the group's sole leaf). A no-op when the target
    /// is the active group. Mirrors the frontend `moveTabToGroup` reducer.
    pub fn move_tab_to_group(
        &self,
        client_id: &str,
        tab_id: &str,
        from_panel_id: &str,
        target_group_id: &str,
    ) -> Result<(), LayoutError> {
        let mut clients = self.lock();
        let client = clients
            .entry(client_id.to_string())
            .or_insert_with(ClientLayout::seeded);
        if target_group_id == client.active_group_id {
            return Ok(());
        }
        if !client.groups.iter().any(|g| g.id == target_group_id) {
            return Err(LayoutError::GroupNotFound(target_group_id.to_string()));
        }

        // Detach the tab from the source (active) group first.
        let tab = detach_tab_from_active_group(client, from_panel_id, tab_id)?;

        // Add it to the target group's first leaf, focused.
        let target = client
            .groups
            .iter_mut()
            .find(|g| g.id == target_group_id)
            .ok_or_else(|| LayoutError::GroupNotFound(target_group_id.to_string()))?;
        let first_leaf_id = get_all_leaves(&target.root)
            .first()
            .map(|l| l.id.clone())
            .ok_or_else(|| LayoutError::PanelNotFound(target_group_id.to_string()))?;
        target.root = update_leaf(&target.root, &first_leaf_id, |leaf| {
            with_tab_added(leaf, tab.clone())
        });
        Ok(())
    }

    /// `layout.addGroupWithTab` — move a tab out of a panel in the **active**
    /// group into a brand-new group holding just that tab, made active. Returns
    /// the new group's id. Mirrors the frontend `addTabGroupWithTab` reducer.
    pub fn add_group_with_tab(
        &self,
        client_id: &str,
        tab_id: &str,
        from_panel_id: &str,
    ) -> Result<String, LayoutError> {
        let mut clients = self.lock();
        let client = clients
            .entry(client_id.to_string())
            .or_insert_with(ClientLayout::seeded);

        let tab = detach_tab_from_active_group(client, from_panel_id, tab_id)?;

        let mut leaf = create_leaf_panel();
        let panel_id = leaf.id.clone();
        let tab_focus = tab.id.clone();
        leaf.tabs = vec![tab];
        leaf.active_tab_id = Some(tab_focus);
        let count = client.groups.len() + 1;
        let group = GroupLayout {
            id: generate_group_id(),
            name: format!("Group {count}"),
            color: None,
            root: PanelNode::Leaf(leaf),
            active_panel_id: Some(panel_id),
        };
        let new_id = group.id.clone();
        client.groups.push(group);
        client.active_group_id = new_id.clone();
        Ok(new_id)
    }

    /// `layout.replace` — install a complete tree for the **active group**,
    /// replacing that group's tree. The seed-before-mutate entry point the
    /// frontend bridge uses to keep the store authoritative for structure while
    /// tab *creation* still lives in `appStore` (partial projection). The active
    /// panel is repointed at a real leaf when the supplied id is absent.
    pub fn replace(&self, client_id: &str, root: PanelNode, active_panel_id: Option<String>) {
        let mut clients = self.lock();
        let client = clients
            .entry(client_id.to_string())
            .or_insert_with(ClientLayout::seeded);
        let active_id = client.active_group_id.clone();
        if let Ok(group) = client.group_mut(Some(&active_id)) {
            group.root = root;
            group.active_panel_id = active_panel_id;
            fix_active(group);
        }
    }

    /// `layout.replaceGroups` — install a complete multi-group layout for a
    /// client, replacing any existing one. The whole-layout twin of [`replace`]
    /// (workspace restore / multi-window install). Each group's active panel is
    /// repointed at a real leaf when absent, and the active group id is repointed
    /// at the first group when it does not name a present group. An empty install
    /// falls back to a freshly-seeded client.
    pub fn replace_groups(
        &self,
        client_id: &str,
        groups: Vec<GroupLayout>,
        active_group_id: String,
    ) {
        let client = if groups.is_empty() {
            ClientLayout::seeded()
        } else {
            let mut client = ClientLayout {
                groups,
                active_group_id,
            };
            for group in client.groups.iter_mut() {
                fix_active(group);
            }
            if !client.groups.iter().any(|g| g.id == client.active_group_id) {
                client.active_group_id = client.groups[0].id.clone();
            }
            client
        };
        self.lock().insert(client_id.to_string(), client);
    }

    /// Install a single-group tree for a client — test-only seeding so intent
    /// tests can start from a populated layout without a tab-creating intent.
    #[cfg(test)]
    pub fn seed_for_test(&self, client_id: &str, root: PanelNode, active_panel_id: Option<String>) {
        let group = GroupLayout {
            id: "group-test".to_string(),
            name: "Main".to_string(),
            color: None,
            root,
            active_panel_id,
        };
        let active_group_id = group.id.clone();
        self.lock().insert(
            client_id.to_string(),
            ClientLayout {
                groups: vec![group],
                active_group_id,
            },
        );
    }

    /// Install a full multi-group layout for a client — test-only seeding.
    #[cfg(test)]
    pub fn seed_groups_for_test(&self, client_id: &str, client: ClientLayout) {
        self.lock().insert(client_id.to_string(), client);
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, ClientLayout>> {
        // Short critical sections only; a poisoned lock means another thread
        // panicked mid-mutation (a bug) — recover rather than cascade.
        self.clients.lock().unwrap_or_else(|e| e.into_inner())
    }
}

// ── Cross-group / pure leaf-tree helpers ─────────────────────────────────────

/// Remove `tab_id` (held by `from_panel_id`) from the client's active group,
/// pruning the emptied source panel unless it is the group's sole leaf, and
/// repointing the group's focus. Returns the detached tab. Shared by
/// [`LayoutStore::move_tab_to_group`] and [`LayoutStore::add_group_with_tab`],
/// which both lift a tab out of the active group before re-homing it.
fn detach_tab_from_active_group(
    client: &mut ClientLayout,
    from_panel_id: &str,
    tab_id: &str,
) -> Result<Tab, LayoutError> {
    let active_id = client.active_group_id.clone();
    let source = client
        .groups
        .iter_mut()
        .find(|g| g.id == active_id)
        .ok_or_else(|| LayoutError::GroupNotFound(active_id.clone()))?;
    let source_leaf = find_leaf(&source.root, from_panel_id)
        .ok_or_else(|| LayoutError::PanelNotFound(from_panel_id.to_string()))?;
    let tab = source_leaf
        .tabs
        .iter()
        .find(|t| t.id == tab_id)
        .cloned()
        .ok_or_else(|| LayoutError::TabNotFound(tab_id.to_string()))?;

    let detached = update_leaf(&source.root, from_panel_id, |leaf| {
        with_tab_removed(leaf, tab_id)
    });
    let now_empty = find_leaf(&detached, from_panel_id)
        .map(|l| l.tabs.is_empty())
        .unwrap_or(false);
    source.root = if now_empty && get_all_leaves(&detached).len() > 1 {
        simplify_tree(&remove_leaf(&detached, from_panel_id).unwrap_or_else(single_empty_leaf))
    } else {
        detached
    };
    fix_active(source);
    Ok(tab)
}

/// A single empty leaf, the collapse target when a whole tree is emptied.
fn single_empty_leaf() -> PanelNode {
    PanelNode::Leaf(create_leaf_panel())
}

/// A copy of `leaf` with `tab_id` removed; when the removed tab was active, the
/// active tab falls back **positionally** — the tab that shifts into the removed
/// slot, or the new last tab. This matches the frontend `removeTabFromLeaf`
/// reducer (`min(idx, len-1)`) exactly.
fn with_tab_removed(leaf: &LeafPanel, tab_id: &str) -> LeafPanel {
    let removed_idx = leaf.tabs.iter().position(|t| t.id == tab_id);
    let tabs: Vec<Tab> = leaf
        .tabs
        .iter()
        .filter(|t| t.id != tab_id)
        .cloned()
        .collect();
    let active_tab_id = if leaf.active_tab_id.as_deref() == Some(tab_id) {
        match removed_idx {
            Some(idx) if !tabs.is_empty() => {
                let new_idx = idx.min(tabs.len() - 1);
                Some(tabs[new_idx].id.clone())
            }
            _ => None,
        }
    } else {
        leaf.active_tab_id.clone()
    };
    LeafPanel {
        id: leaf.id.clone(),
        tabs,
        active_tab_id,
    }
}

/// A copy of `leaf` with `tab` appended and focused.
fn with_tab_added(leaf: &LeafPanel, tab: Tab) -> LeafPanel {
    let mut tabs = leaf.tabs.clone();
    let active_tab_id = Some(tab.id.clone());
    tabs.push(tab);
    LeafPanel {
        id: leaf.id.clone(),
        tabs,
        active_tab_id,
    }
}

/// A copy of `leaf` with `extra` appended; focuses the first appended tab only
/// when the target had no active tab yet.
fn with_tabs_appended(leaf: &LeafPanel, extra: &[Tab]) -> LeafPanel {
    let mut tabs = leaf.tabs.clone();
    tabs.extend(extra.iter().cloned());
    let active_tab_id = leaf
        .active_tab_id
        .clone()
        .or_else(|| extra.first().map(|t| t.id.clone()));
    LeafPanel {
        id: leaf.id.clone(),
        tabs,
        active_tab_id,
    }
}

/// A copy of `leaf` with the tab at `old_index` moved to `new_index`, preserving
/// the active tab. Callers validate the indices against the tab count first.
fn with_tabs_reordered(leaf: &LeafPanel, old_index: usize, new_index: usize) -> LeafPanel {
    let mut tabs = leaf.tabs.clone();
    let moved = tabs.remove(old_index);
    tabs.insert(new_index.min(tabs.len()), moved);
    LeafPanel {
        id: leaf.id.clone(),
        tabs,
        active_tab_id: leaf.active_tab_id.clone(),
    }
}

/// Find a split container by id anywhere in the tree.
fn find_split<'a>(root: &'a PanelNode, split_id: &str) -> Option<&'a SplitContainer> {
    match root {
        PanelNode::Leaf(_) => None,
        PanelNode::Split(split) => {
            if split.id == split_id {
                return Some(split);
            }
            split.children.iter().find_map(|c| find_split(c, split_id))
        }
    }
}

/// Return a copy of the tree with `split_id`'s `sizes` set to `sizes`. A no-op
/// structural clone when the id is absent (callers validate existence first).
fn set_split_sizes(root: &PanelNode, split_id: &str, sizes: &[f64]) -> PanelNode {
    match root {
        PanelNode::Leaf(leaf) => PanelNode::Leaf(leaf.clone()),
        PanelNode::Split(split) => {
            let children = split
                .children
                .iter()
                .map(|c| set_split_sizes(c, split_id, sizes))
                .collect();
            let new_sizes = if split.id == split_id {
                Some(sizes.to_vec())
            } else {
                split.sizes.clone()
            };
            PanelNode::Split(SplitContainer {
                id: split.id.clone(),
                direction: split.direction,
                children,
                sizes: new_sizes,
                last_active_leaf_id: split.last_active_leaf_id.clone(),
            })
        }
    }
}

/// Remove `leaf_id` from the tree iff it is an empty leaf, collapsing an emptied
/// tree to a single empty leaf rather than nothing.
fn remove_leaf_if_empty(root: &PanelNode, leaf_id: &str) -> PanelNode {
    match find_leaf(root, leaf_id) {
        Some(leaf) if leaf.tabs.is_empty() => {
            remove_leaf(root, leaf_id).unwrap_or_else(single_empty_leaf)
        }
        _ => root.clone(),
    }
}

/// Repoint a group's `active_panel_id` at an existing leaf when the current one
/// is gone.
fn fix_active(group: &mut GroupLayout) {
    let still_present = group
        .active_panel_id
        .as_deref()
        .map(|id| find_leaf(&group.root, id).is_some())
        .unwrap_or(false);
    if !still_present {
        group.active_panel_id = get_all_leaves(&group.root).first().map(|l| l.id.clone());
    }
}

/// Generate a unique tab-group id (mirrors the TS `group-<ts>-<n>` shape).
fn generate_group_id() -> String {
    static GROUP_COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = GROUP_COUNTER.fetch_add(1, Ordering::Relaxed) + 1;
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("group-{millis}-{n}")
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
