//! The authoritative, client-scoped panel-tree + tab model behind the shadow
//! `layout@<clientId>` projection region (#2151).
//!
//! Every structural transform delegates to the pure panel-tree algebra ported in
//! #2143 (`termihub_core::layout::panel_tree`) — this module only owns the
//! per-client authoritative trees and turns the four `layout.*` intents into
//! algebra calls. It holds **only** the structure + minimal tab model
//! (`{ id, sessionId, contentType }`, exactly the seam the ported `Tab` models);
//! session status, tab colours, and broadcast membership stay in `appStore`
//! under partial projection and migrate in later phases.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use serde_json::{json, Value};

use termihub_core::layout::panel_tree::{
    create_leaf_panel, edge_to_split, find_leaf, find_leaf_by_tab, generate_panel_id,
    get_all_leaves, remove_leaf, simplify_tree, split_leaf, update_leaf, Direction, DropEdge,
    LeafPanel, PanelNode, Position, Tab,
};

/// A rejectable layout-intent failure. Maps to an intent ack `(code, message)`
/// in [`super::projection`].
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum LayoutError {
    /// A referenced leaf panel id is not present in the client's tree.
    #[error("panel not found: {0}")]
    PanelNotFound(String),
    /// A referenced tab id is not present in the client's tree.
    #[error("tab not found: {0}")]
    TabNotFound(String),
    /// A `moveTab` used the `center` edge where a real split edge was required,
    /// or vice versa — a malformed payload.
    #[error("invalid split edge")]
    BadEdge,
    /// `merge` was asked to merge a panel into itself.
    #[error("source and target panels are the same")]
    SamePanel,
}

impl LayoutError {
    /// The stable intent-ack error code for this failure.
    pub fn code(&self) -> &'static str {
        match self {
            LayoutError::PanelNotFound(_) => "panel_not_found",
            LayoutError::TabNotFound(_) => "tab_not_found",
            LayoutError::BadEdge | LayoutError::SamePanel => "bad_payload",
        }
    }
}

/// One client's authoritative layout: its panel tree plus the focused panel.
#[derive(Clone, Debug, PartialEq)]
struct LayoutState {
    root: PanelNode,
    active_panel_id: Option<String>,
}

impl LayoutState {
    /// A freshly-seeded layout: a single empty leaf panel, focused.
    fn seeded() -> Self {
        let leaf = create_leaf_panel();
        let id = leaf.id.clone();
        Self {
            root: PanelNode::Leaf(leaf),
            active_panel_id: Some(id),
        }
    }

    /// The render-ready view model for this client's region.
    fn view(&self) -> Value {
        json!({ "root": self.root, "activePanelId": self.active_panel_id })
    }
}

/// The shadow layout authority. Owns one [`LayoutState`] per attached client,
/// keyed by `clientId`; an unknown client is seeded lazily on first touch.
#[derive(Default)]
pub struct LayoutStore {
    clients: Mutex<HashMap<String, LayoutState>>,
}

impl LayoutStore {
    /// A store with no clients yet. Regions are seeded lazily per `clientId`.
    pub fn new() -> Self {
        Self::default()
    }

    /// The current render-ready view model for a client (seeding it if unknown).
    ///
    /// Pure with respect to layout structure — it never mutates an existing
    /// client — so the projector can safely diff two consecutive snapshots.
    pub fn snapshot(&self, client_id: &str) -> Value {
        self.lock()
            .entry(client_id.to_string())
            .or_insert_with(LayoutState::seeded)
            .view()
    }

    /// `layout.split` — split a leaf panel, inserting a new empty leaf beside it
    /// and focusing the new leaf.
    pub fn split(
        &self,
        client_id: &str,
        panel_id: &str,
        direction: Direction,
        position: Position,
    ) -> Result<(), LayoutError> {
        let mut clients = self.lock();
        let state = clients
            .entry(client_id.to_string())
            .or_insert_with(LayoutState::seeded);
        if find_leaf(&state.root, panel_id).is_none() {
            return Err(LayoutError::PanelNotFound(panel_id.to_string()));
        }
        let new_leaf = create_leaf_panel();
        let new_id = new_leaf.id.clone();
        state.root = split_leaf(&state.root, panel_id, &new_leaf, direction, position);
        state.active_panel_id = Some(new_id);
        fix_active(state);
        Ok(())
    }

    /// `layout.merge` — move every tab of `source_panel_id` into
    /// `target_panel_id`, drop the now-empty source panel, and simplify.
    pub fn merge(
        &self,
        client_id: &str,
        source_panel_id: &str,
        target_panel_id: &str,
    ) -> Result<(), LayoutError> {
        if source_panel_id == target_panel_id {
            return Err(LayoutError::SamePanel);
        }
        let mut clients = self.lock();
        let state = clients
            .entry(client_id.to_string())
            .or_insert_with(LayoutState::seeded);
        let tabs = find_leaf(&state.root, source_panel_id)
            .ok_or_else(|| LayoutError::PanelNotFound(source_panel_id.to_string()))?
            .tabs
            .clone();
        if find_leaf(&state.root, target_panel_id).is_none() {
            return Err(LayoutError::PanelNotFound(target_panel_id.to_string()));
        }
        let merged = update_leaf(&state.root, target_panel_id, |leaf| {
            with_tabs_appended(leaf, &tabs)
        });
        let pruned =
            remove_leaf(&merged, source_panel_id).unwrap_or_else(|| single_empty_leaf());
        state.root = simplify_tree(&pruned);
        state.active_panel_id = Some(target_panel_id.to_string());
        fix_active(state);
        Ok(())
    }

    /// `layout.moveTab` — move a tab to a target panel. A `center` edge drops it
    /// into the target's tab stack (a merge); any other edge splits the target
    /// and places the tab in the new leaf. The source panel is pruned if it is
    /// left empty.
    pub fn move_tab(
        &self,
        client_id: &str,
        tab_id: &str,
        target_panel_id: &str,
        edge: DropEdge,
    ) -> Result<(), LayoutError> {
        let mut clients = self.lock();
        let state = clients
            .entry(client_id.to_string())
            .or_insert_with(LayoutState::seeded);
        let source_leaf = find_leaf_by_tab(&state.root, tab_id)
            .ok_or_else(|| LayoutError::TabNotFound(tab_id.to_string()))?;
        let source_id = source_leaf.id.clone();
        let tab = source_leaf
            .tabs
            .iter()
            .find(|t| t.id == tab_id)
            .cloned()
            .ok_or_else(|| LayoutError::TabNotFound(tab_id.to_string()))?;
        if find_leaf(&state.root, target_panel_id).is_none() {
            return Err(LayoutError::PanelNotFound(target_panel_id.to_string()));
        }

        let detached = update_leaf(&state.root, &source_id, |leaf| with_tab_removed(leaf, tab_id));
        let placed = match edge {
            DropEdge::Center => {
                update_leaf(&detached, target_panel_id, |leaf| with_tab_added(leaf, tab.clone()))
            }
            edge => {
                let spec = edge_to_split(edge).ok_or(LayoutError::BadEdge)?;
                let new_leaf = LeafPanel {
                    id: generate_panel_id(),
                    tabs: vec![tab.clone()],
                    active_tab_id: Some(tab.id.clone()),
                };
                split_leaf(&detached, target_panel_id, &new_leaf, spec.direction, spec.position)
            }
        };
        let pruned = remove_leaf_if_empty(&placed, &source_id);
        state.root = simplify_tree(&pruned);
        fix_active(state);
        Ok(())
    }

    /// `layout.closeTabStructure` — remove a tab from the tree, dropping its leaf
    /// if it becomes empty. Only the structural half of closing a tab; session
    /// teardown stays in `appStore` under partial projection (later phases).
    pub fn close_tab_structure(&self, client_id: &str, tab_id: &str) -> Result<(), LayoutError> {
        let mut clients = self.lock();
        let state = clients
            .entry(client_id.to_string())
            .or_insert_with(LayoutState::seeded);
        let leaf_id = find_leaf_by_tab(&state.root, tab_id)
            .ok_or_else(|| LayoutError::TabNotFound(tab_id.to_string()))?
            .id
            .clone();
        let detached = update_leaf(&state.root, &leaf_id, |leaf| with_tab_removed(leaf, tab_id));
        let pruned = remove_leaf_if_empty(&detached, &leaf_id);
        state.root = simplify_tree(&pruned);
        fix_active(state);
        Ok(())
    }

    /// Install a specific tree for a client — test-only seeding so intent tests
    /// can start from a populated layout without a tab-creating intent (tabs
    /// enter via session creation in `appStore`, out of this shadow's scope).
    #[cfg(test)]
    pub fn seed_for_test(&self, client_id: &str, root: PanelNode, active_panel_id: Option<String>) {
        self.lock().insert(
            client_id.to_string(),
            LayoutState {
                root,
                active_panel_id,
            },
        );
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, LayoutState>> {
        // Short critical sections only; a poisoned lock means another thread
        // panicked mid-mutation (a bug) — recover rather than cascade.
        self.clients.lock().unwrap_or_else(|e| e.into_inner())
    }
}

// ── Pure leaf/tree helpers ───────────────────────────────────────────────────

/// A single empty leaf, the collapse target when a whole tree is emptied.
fn single_empty_leaf() -> PanelNode {
    PanelNode::Leaf(create_leaf_panel())
}

/// A copy of `leaf` with `tab_id` removed; the active tab falls back to the
/// first remaining tab when the removed tab was active.
fn with_tab_removed(leaf: &LeafPanel, tab_id: &str) -> LeafPanel {
    let tabs: Vec<Tab> = leaf.tabs.iter().filter(|t| t.id != tab_id).cloned().collect();
    let active_tab_id = if leaf.active_tab_id.as_deref() == Some(tab_id) {
        tabs.first().map(|t| t.id.clone())
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

/// Repoint `active_panel_id` at an existing leaf when the current one is gone.
fn fix_active(state: &mut LayoutState) {
    let still_present = state
        .active_panel_id
        .as_deref()
        .map(|id| find_leaf(&state.root, id).is_some())
        .unwrap_or(false);
    if !still_present {
        state.active_panel_id = get_all_leaves(&state.root).first().map(|l| l.id.clone());
    }
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
