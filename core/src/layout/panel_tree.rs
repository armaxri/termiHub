//! Panel-tree algebra — the pure functions that split, merge, insert, remove
//! and navigate the terminal panel layout.
//!
//! This is a faithful Rust port of the frontend's `src/utils/panelTree.ts`.
//! Every exported function mirrors its TypeScript twin's semantics exactly. The
//! TypeScript version stays authoritative during the stateless-UI migration
//! (#2139); this port is proven equivalent through golden-vector fixtures
//! (`core/tests/fixtures/golden/panel_tree/`) extracted from the TS test suite,
//! and gains property tests over the tree invariants. Phase 3 (#2151) activates
//! it as the backing `LayoutStore`.
//!
//! The tree is an immutable persistent structure: every transforming function
//! takes `&PanelNode` and returns a fresh tree, never mutating its input.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// A terminal tab. Only the fields the panel-tree algebra reads are modelled
/// here (`id`, `sessionId`, `contentType`); the full frontend `TerminalTab`
/// carries many more, but none affect any layout operation. Keeping this a
/// minimal projection keeps the golden fixtures small and the equivalence
/// precise.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Tab {
    pub id: String,
    /// Session bound to the tab, or `None` while it is still connecting.
    #[serde(default)]
    pub session_id: Option<String>,
    /// Tab content kind (`"terminal"`, `"settings"`, …); drives drop routing.
    pub content_type: String,
}

/// A leaf panel: a single pane holding a stack of tabs.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LeafPanel {
    pub id: String,
    pub tabs: Vec<Tab>,
    #[serde(default)]
    pub active_tab_id: Option<String>,
}

/// A split container: an ordered row/column of child nodes.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SplitContainer {
    pub id: String,
    pub direction: Direction,
    pub children: Vec<PanelNode>,
    /// Percentage sizes for each child (sum to 100, length matches `children`).
    /// Absent when the split has never been resized.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sizes: Option<Vec<f64>>,
    /// The last leaf focused within this subtree; steers directional navigation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_active_leaf_id: Option<String>,
}

/// A node in the panel tree: either a leaf pane or a split container.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum PanelNode {
    Leaf(LeafPanel),
    Split(SplitContainer),
}

/// A workspace-level tab group with its own independent panel tree. Only the
/// fields the empty-window helpers read are modelled.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabGroup {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub root_panel: PanelNode,
    #[serde(default)]
    pub active_panel_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

/// Split axis.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Horizontal,
    Vertical,
}

/// Insertion side relative to a target when splitting.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Position {
    Before,
    After,
}

/// The edge of a drop target a drag was released on.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DropEdge {
    Left,
    Right,
    Top,
    Bottom,
    Center,
}

/// Direction of a directional-focus move.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FocusDirection {
    Up,
    Down,
    Left,
    Right,
}

/// The split direction + position an edge resolves to (`None` = center).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SplitSpec {
    pub direction: Direction,
    pub position: Position,
}

/// Which edge leaf to descend to when entering a subtree.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EdgeSide {
    First,
    Last,
}

/// Total number of tabs across every leaf of a panel tree.
pub fn count_tabs_in_tree(root: &PanelNode) -> usize {
    get_all_leaves(root)
        .iter()
        .map(|leaf| leaf.tabs.len())
        .sum()
}

/// Whether a native window holds zero tabs across every tab group — the
/// empty-window first-class state (#1902). The active group's live tree is
/// passed separately (it is authoritative over the stale copy stored in
/// `tab_groups`); inactive groups use their stored `root_panel`.
pub fn is_window_empty(
    active_root_panel: &PanelNode,
    tab_groups: &[TabGroup],
    active_tab_group_id: Option<&str>,
) -> bool {
    if count_tabs_in_tree(active_root_panel) > 0 {
        return false;
    }
    tab_groups
        .iter()
        .filter(|g| Some(g.id.as_str()) != active_tab_group_id)
        .all(|g| count_tabs_in_tree(&g.root_panel) == 0)
}

/// Normalize an array of sizes so they sum to exactly 100.
pub fn normalize_sizes(sizes: &[f64]) -> Vec<f64> {
    let total: f64 = sizes.iter().sum();
    if total == 0.0 {
        let n = sizes.len();
        return sizes.iter().map(|_| 100.0 / n as f64).collect();
    }
    sizes.iter().map(|s| (s / total) * 100.0).collect()
}

static PANEL_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Generate a unique panel ID (mirrors the TS `panel-<ts>-<n>-<rand>` shape).
pub fn generate_panel_id() -> String {
    let n = PANEL_COUNTER.fetch_add(1, Ordering::Relaxed) + 1;
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let suffix: String = (0..4)
        .map(|_| {
            let v = rand::random::<u32>() % 36;
            char::from_digit(v, 36).unwrap_or('0')
        })
        .collect();
    format!("panel-{millis}-{n}-{suffix}")
}

/// Create a new empty leaf panel.
pub fn create_leaf_panel() -> LeafPanel {
    LeafPanel {
        id: generate_panel_id(),
        tabs: Vec::new(),
        active_tab_id: None,
    }
}

/// Whether any node in the tree — leaf **or** split container — already carries
/// `id`. Used to reject a client-supplied id that would collide before adopting
/// it (#2708), falling back to a freshly-minted one.
pub fn contains_panel_id(root: &PanelNode, id: &str) -> bool {
    match root {
        PanelNode::Leaf(leaf) => leaf.id == id,
        PanelNode::Split(split) => {
            split.id == id || split.children.iter().any(|c| contains_panel_id(c, id))
        }
    }
}

/// Find a leaf by ID.
pub fn find_leaf<'a>(root: &'a PanelNode, leaf_id: &str) -> Option<&'a LeafPanel> {
    match root {
        PanelNode::Leaf(leaf) => {
            if leaf.id == leaf_id {
                Some(leaf)
            } else {
                None
            }
        }
        PanelNode::Split(split) => {
            for child in &split.children {
                if let Some(found) = find_leaf(child, leaf_id) {
                    return Some(found);
                }
            }
            None
        }
    }
}

/// Find the leaf containing a specific tab.
pub fn find_leaf_by_tab<'a>(root: &'a PanelNode, tab_id: &str) -> Option<&'a LeafPanel> {
    match root {
        PanelNode::Leaf(leaf) => {
            if leaf.tabs.iter().any(|t| t.id == tab_id) {
                Some(leaf)
            } else {
                None
            }
        }
        PanelNode::Split(split) => {
            for child in &split.children {
                if let Some(found) = find_leaf_by_tab(child, tab_id) {
                    return Some(found);
                }
            }
            None
        }
    }
}

/// Resolve the session ID of the terminal tab currently shown in a leaf panel.
///
/// Returns `None` when the panel is empty, its active tab is not a terminal, or
/// the terminal has not connected yet. Used to route OS file drops to the
/// session of the pane under the cursor so each pane is its own drop target.
pub fn get_panel_active_session_id(panel: &LeafPanel) -> Option<&str> {
    let active_tab = panel
        .tabs
        .iter()
        .find(|t| Some(t.id.as_str()) == panel.active_tab_id.as_deref())?;
    if active_tab.content_type != "terminal" {
        return None;
    }
    active_tab.session_id.as_deref()
}

/// Get a flat list of all leaves in the tree, left-to-right.
pub fn get_all_leaves(root: &PanelNode) -> Vec<&LeafPanel> {
    match root {
        PanelNode::Leaf(leaf) => vec![leaf],
        PanelNode::Split(split) => {
            let mut result = Vec::new();
            for child in &split.children {
                result.extend(get_all_leaves(child));
            }
            result
        }
    }
}

/// Immutably update a single leaf by ID.
pub fn update_leaf<F>(root: &PanelNode, leaf_id: &str, updater: F) -> PanelNode
where
    F: Fn(&LeafPanel) -> LeafPanel,
{
    update_leaf_inner(root, leaf_id, &updater)
}

fn update_leaf_inner(
    root: &PanelNode,
    leaf_id: &str,
    updater: &dyn Fn(&LeafPanel) -> LeafPanel,
) -> PanelNode {
    match root {
        PanelNode::Leaf(leaf) => {
            if leaf.id == leaf_id {
                PanelNode::Leaf(updater(leaf))
            } else {
                PanelNode::Leaf(leaf.clone())
            }
        }
        PanelNode::Split(split) => PanelNode::Split(SplitContainer {
            id: split.id.clone(),
            direction: split.direction,
            children: split
                .children
                .iter()
                .map(|child| update_leaf_inner(child, leaf_id, updater))
                .collect(),
            sizes: split.sizes.clone(),
            last_active_leaf_id: split.last_active_leaf_id.clone(),
        }),
    }
}

/// Remove a leaf from the tree and unwrap single-child splits.
/// Returns `None` if the removed leaf was the root.
pub fn remove_leaf(root: &PanelNode, leaf_id: &str) -> Option<PanelNode> {
    let split = match root {
        PanelNode::Leaf(leaf) => {
            return if leaf.id == leaf_id {
                None
            } else {
                Some(PanelNode::Leaf(leaf.clone()))
            };
        }
        PanelNode::Split(split) => split,
    };

    let results: Vec<Option<PanelNode>> = split
        .children
        .iter()
        .map(|child| remove_leaf(child, leaf_id))
        .collect();
    let mut new_children: Vec<PanelNode> = results.iter().flatten().cloned().collect();

    if new_children.is_empty() {
        return None;
    }
    if new_children.len() == 1 {
        return Some(new_children.remove(0));
    }

    // Recalculate sizes if present.
    let new_sizes = split.sizes.as_ref().map(|sizes| {
        let mut kept: Vec<f64> = Vec::new();
        let mut removed_size = 0.0;
        for (i, result) in results.iter().enumerate() {
            let size = sizes.get(i).copied().unwrap_or(0.0);
            if result.is_none() {
                removed_size += size;
            } else {
                kept.push(size);
            }
        }
        if !kept.is_empty() && removed_size > 0.0 {
            let remaining_total: f64 = kept.iter().sum();
            if remaining_total > 0.0 {
                let grown: Vec<f64> = kept
                    .iter()
                    .map(|s| s + (removed_size * s) / remaining_total)
                    .collect();
                normalize_sizes(&grown)
            } else {
                let len = kept.len();
                kept.iter().map(|_| 100.0 / len as f64).collect()
            }
        } else {
            kept
        }
    });

    Some(PanelNode::Split(SplitContainer {
        id: split.id.clone(),
        direction: split.direction,
        children: new_children,
        sizes: new_sizes,
        last_active_leaf_id: split.last_active_leaf_id.clone(),
    }))
}

/// Split a leaf by wrapping it in a `SplitContainer` with a new leaf.
/// If the parent already splits in the same direction, inserts as a sibling
/// instead of nesting.
pub fn split_leaf(
    root: &PanelNode,
    target_id: &str,
    new_leaf: &LeafPanel,
    direction: Direction,
    position: Position,
) -> PanelNode {
    split_leaf_with_id(root, target_id, new_leaf, direction, position, None)
}

/// Like [`split_leaf`], but adopts `new_split_id` as the id of the wrapping
/// `SplitContainer` when a **new** container is created (a wrap), instead of
/// minting one. This lets an optimistic frontend split and this authoritative
/// split produce byte-identical container ids, eliminating the
/// optimistic→authoritative id churn (#2708). It is ignored when the split
/// inserts as a sibling of an existing same-direction container (no new
/// container is created, so the existing id is preserved). `None` mints a fresh
/// id via [`generate_panel_id`], matching the pre-#2708 behaviour.
pub fn split_leaf_with_id(
    root: &PanelNode,
    target_id: &str,
    new_leaf: &LeafPanel,
    direction: Direction,
    position: Position,
    new_split_id: Option<&str>,
) -> PanelNode {
    let split = match root {
        PanelNode::Leaf(leaf) => {
            if leaf.id != target_id {
                return PanelNode::Leaf(leaf.clone());
            }
            let children = match position {
                Position::Before => vec![
                    PanelNode::Leaf(new_leaf.clone()),
                    PanelNode::Leaf(leaf.clone()),
                ],
                Position::After => vec![
                    PanelNode::Leaf(leaf.clone()),
                    PanelNode::Leaf(new_leaf.clone()),
                ],
            };
            return PanelNode::Split(SplitContainer {
                id: new_split_id
                    .map(str::to_string)
                    .unwrap_or_else(generate_panel_id),
                direction,
                children,
                sizes: None,
                last_active_leaf_id: None,
            });
        }
        PanelNode::Split(split) => split,
    };

    // Check if target is a direct leaf child and directions match — insert as
    // a sibling.
    let target_index = split
        .children
        .iter()
        .position(|c| matches!(c, PanelNode::Leaf(l) if l.id == target_id));
    if let Some(target_index) = target_index {
        if split.direction == direction {
            let insert_idx = match position {
                Position::Before => target_index,
                Position::After => target_index + 1,
            };
            let mut new_children = split.children.clone();
            new_children.insert(insert_idx, PanelNode::Leaf(new_leaf.clone()));
            // Recalculate sizes: halve the target child's size for the new sibling.
            let new_sizes = split.sizes.as_ref().map(|sizes| {
                let mut ns = sizes.clone();
                let half_size = ns.get(target_index).copied().unwrap_or(f64::NAN) / 2.0;
                if target_index < ns.len() {
                    ns[target_index] = half_size;
                }
                ns.insert(insert_idx.min(ns.len()), half_size);
                ns
            });
            return PanelNode::Split(SplitContainer {
                id: split.id.clone(),
                direction: split.direction,
                children: new_children,
                sizes: new_sizes,
                last_active_leaf_id: split.last_active_leaf_id.clone(),
            });
        }
    }

    // Recurse into children.
    PanelNode::Split(SplitContainer {
        id: split.id.clone(),
        direction: split.direction,
        children: split
            .children
            .iter()
            .map(|child| {
                split_leaf_with_id(
                    child,
                    target_id,
                    new_leaf,
                    direction,
                    position,
                    new_split_id,
                )
            })
            .collect(),
        sizes: split.sizes.clone(),
        last_active_leaf_id: split.last_active_leaf_id.clone(),
    })
}

/// Flatten same-direction nesting and unwrap single-child containers.
pub fn simplify_tree(root: &PanelNode) -> PanelNode {
    let split = match root {
        PanelNode::Leaf(leaf) => return PanelNode::Leaf(leaf.clone()),
        PanelNode::Split(split) => split,
    };

    // First simplify children.
    let simplified: Vec<PanelNode> = split.children.iter().map(simplify_tree).collect();

    // Flatten children that split in the same direction.
    let mut flattened: Vec<PanelNode> = Vec::new();
    for child in simplified {
        match &child {
            PanelNode::Split(child_split) if child_split.direction == split.direction => {
                flattened.extend(child_split.children.iter().cloned());
            }
            _ => flattened.push(child),
        }
    }

    if flattened.is_empty() {
        return PanelNode::Leaf(create_leaf_panel());
    }
    if flattened.len() == 1 {
        return flattened.remove(0);
    }
    PanelNode::Split(SplitContainer {
        id: split.id.clone(),
        direction: split.direction,
        children: flattened,
        sizes: split.sizes.clone(),
        last_active_leaf_id: split.last_active_leaf_id.clone(),
    })
}

/// Collapse degenerate `Split` nodes so the tree upholds the invariant every
/// operation here assumes: a `Split` has **at least two children**.
///
/// The pure operations in this module always maintain that invariant, but a tree
/// can still *arrive* violating it. Layout state is persisted and restored
/// (workspace save/restore), and a file that was hand-edited, truncated, or
/// written by an older/buggy build can carry an empty `Split` (`children: []`)
/// or a single-child `Split`. Directional navigation then walks into the empty
/// child vector and panics the layout thread — a crash-on-open on restored state
/// (CORE-038). Run this on any externally-sourced tree before storing it:
///
/// - an empty `Split` collapses to a fresh empty leaf,
/// - a single-child `Split` collapses to that child,
/// - otherwise its children are sanitized recursively, and a `sizes` array whose
///   length no longer matches the child count is dropped (it would desync).
///
/// Unlike [`simplify_tree`] this does **not** flatten same-direction nesting; it
/// only removes the degenerate shapes that can panic, so a well-formed tree round
/// trips through it unchanged.
pub fn sanitize_tree(root: &PanelNode) -> PanelNode {
    let split = match root {
        PanelNode::Leaf(leaf) => return PanelNode::Leaf(leaf.clone()),
        PanelNode::Split(split) => split,
    };

    let mut children: Vec<PanelNode> = split.children.iter().map(sanitize_tree).collect();

    if children.is_empty() {
        return single_empty_leaf();
    }
    if children.len() == 1 {
        return children.remove(0);
    }

    // Drop a `sizes` array that no longer matches the child count — a hand-edited
    // file can carry a stale one, and a mismatched array desyncs from children.
    let sizes = split
        .sizes
        .as_ref()
        .filter(|s| s.len() == children.len())
        .cloned();

    PanelNode::Split(SplitContainer {
        id: split.id.clone(),
        direction: split.direction,
        children,
        sizes,
        last_active_leaf_id: split.last_active_leaf_id.clone(),
    })
}

/// Convert a `DropEdge` to split direction and position, or `None` for center.
pub fn edge_to_split(edge: DropEdge) -> Option<SplitSpec> {
    match edge {
        DropEdge::Left => Some(SplitSpec {
            direction: Direction::Horizontal,
            position: Position::Before,
        }),
        DropEdge::Right => Some(SplitSpec {
            direction: Direction::Horizontal,
            position: Position::After,
        }),
        DropEdge::Top => Some(SplitSpec {
            direction: Direction::Vertical,
            position: Position::Before,
        }),
        DropEdge::Bottom => Some(SplitSpec {
            direction: Direction::Vertical,
            position: Position::After,
        }),
        DropEdge::Center => None,
    }
}

/// A copy of `leaf` with `tab_id` removed. When the removed tab was the active
/// one, the active tab falls back **positionally** — the tab that shifts into the
/// removed slot, or the new last tab (`min(idx, len-1)`) — matching the frontend
/// `removeTabFromLeaf` and the desktop `with_tab_removed` exactly.
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

/// A single empty leaf — the collapse target when a whole tree is emptied.
fn single_empty_leaf() -> PanelNode {
    PanelNode::Leaf(create_leaf_panel())
}

/// Remove `leaf_id` from the tree iff it is now an empty leaf, collapsing an
/// emptied tree to a single empty leaf rather than nothing. A structural clone
/// when the leaf still holds tabs or is absent.
fn remove_leaf_if_empty(root: &PanelNode, leaf_id: &str) -> PanelNode {
    match find_leaf(root, leaf_id) {
        Some(leaf) if leaf.tabs.is_empty() => {
            remove_leaf(root, leaf_id).unwrap_or_else(single_empty_leaf)
        }
        _ => root.clone(),
    }
}

/// Move a tab onto a target panel in a **single atomic tree transform** — detach
/// it from its source leaf, place it at the target, then prune the emptied source
/// leaf and simplify, all in one rewrite that yields the settled tree directly.
///
/// A `Center` edge merges the tab into the target leaf's stack; any other edge
/// splits the target and drops the tab into a new leaf on that side. When the move
/// empties the source leaf it is pruned in the *same* transform, so the settled
/// tree is produced without ever materialising the intermediate **pre-prune**
/// state (the source panel still present alongside the destination). That
/// intermediate two-panel geometry is exactly what, when emitted through the
/// optimistic→authoritative layout-region round-trip (#2283), briefly reflowed a
/// terminal to a narrow width and destroyed its scrollback on macOS/WKWebView
/// (#2712, the same round-trip behind #2705's stale-id facet). Keeping the move
/// atomic here means no caller can observe a transient extra panel or narrower
/// interim width.
///
/// Returns a structural clone unchanged when the tab, or the target panel, is
/// absent (a defensive no-op, mirroring the frontend `splitPanelWithTab` guards
/// and the desktop `LayoutStore::move_tab`). This is a faithful Rust port of the
/// frontend move; every panel id is preserved, so a live pane keyed by id is
/// reparented, never remounted.
pub fn move_tab(
    root: &PanelNode,
    tab_id: &str,
    target_panel_id: &str,
    edge: DropEdge,
) -> PanelNode {
    let source = match find_leaf_by_tab(root, tab_id) {
        Some(leaf) => leaf,
        None => return root.clone(),
    };
    let source_id = source.id.clone();
    let tab = match source.tabs.iter().find(|t| t.id == tab_id) {
        Some(t) => t.clone(),
        None => return root.clone(),
    };
    if find_leaf(root, target_panel_id).is_none() {
        return root.clone();
    }

    let detached = update_leaf(root, &source_id, |leaf| with_tab_removed(leaf, tab_id));
    let placed = match edge_to_split(edge) {
        // Center (no split): merge the tab into the target leaf's stack.
        None => update_leaf(&detached, target_panel_id, |leaf| {
            with_tab_added(leaf, tab.clone())
        }),
        // Edge: split the target and drop the tab into a fresh leaf.
        Some(spec) => {
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
    simplify_tree(&pruned)
}

/// One step on the path from root to a leaf: the split and the child index taken.
struct PathEntry<'a> {
    node: &'a SplitContainer,
    child_index: usize,
}

/// Build the path from root to a leaf, returning the ancestor splits and the
/// child index at each level. `Some(vec![])` means the root itself is the leaf.
fn build_path<'a>(root: &'a PanelNode, leaf_id: &str) -> Option<Vec<PathEntry<'a>>> {
    match root {
        PanelNode::Leaf(leaf) => {
            if leaf.id == leaf_id {
                Some(Vec::new())
            } else {
                None
            }
        }
        PanelNode::Split(split) => {
            for (i, child) in split.children.iter().enumerate() {
                if let Some(mut sub) = build_path(child, leaf_id) {
                    let mut path = vec![PathEntry {
                        node: split,
                        child_index: i,
                    }];
                    path.append(&mut sub);
                    return Some(path);
                }
            }
            None
        }
    }
}

/// Mark every ancestor `SplitContainer` of the given leaf with
/// `last_active_leaf_id`. Returns a new tree. If the leaf is not found, returns
/// a structural copy of the tree unchanged.
pub fn mark_active_leaf(root: &PanelNode, leaf_id: &str) -> PanelNode {
    let split = match root {
        PanelNode::Leaf(leaf) => return PanelNode::Leaf(leaf.clone()),
        PanelNode::Split(split) => split,
    };

    let mut changed = false;
    let new_children: Vec<PanelNode> = split
        .children
        .iter()
        .map(|child| {
            let updated = mark_active_leaf(child, leaf_id);
            if &updated != child {
                changed = true;
            }
            updated
        })
        .collect();

    // Check if the leaf is somewhere in this subtree.
    let contains_leaf = find_leaf(root, leaf_id).is_some();
    if !contains_leaf {
        if changed {
            return PanelNode::Split(SplitContainer {
                id: split.id.clone(),
                direction: split.direction,
                children: new_children,
                sizes: split.sizes.clone(),
                last_active_leaf_id: split.last_active_leaf_id.clone(),
            });
        }
        return PanelNode::Split(split.clone());
    }

    // Already marked and nothing below changed → unchanged.
    if split.last_active_leaf_id.as_deref() == Some(leaf_id) && !changed {
        return PanelNode::Split(split.clone());
    }

    PanelNode::Split(SplitContainer {
        id: split.id.clone(),
        direction: split.direction,
        children: new_children,
        sizes: split.sizes.clone(),
        last_active_leaf_id: Some(leaf_id.to_string()),
    })
}

/// Get the first/last leaf by walking into the first/last child recursively.
///
/// Returns `None` for a degenerate empty `Split` (no children). The algebra
/// never produces such a node, but a restored or hand-edited workspace file can
/// carry one (CORE-038); returning `None` here — rather than indexing an empty
/// child vector — keeps directional navigation panic-free.
fn edge_leaf(node: &PanelNode, side: EdgeSide) -> Option<&LeafPanel> {
    match node {
        PanelNode::Leaf(leaf) => Some(leaf),
        PanelNode::Split(split) => {
            let idx = match side {
                EdgeSide::First => 0,
                EdgeSide::Last => split.children.len().checked_sub(1)?,
            };
            edge_leaf(split.children.get(idx)?, side)
        }
    }
}

/// Return the preferred leaf when entering a subtree: if the node remembers a
/// `last_active_leaf_id` that still exists, return that leaf; otherwise fall
/// back to the edge leaf (first or last). `None` when the subtree holds no leaf
/// (a degenerate empty `Split`, CORE-038).
fn preferred_leaf(node: &PanelNode, fallback_side: EdgeSide) -> Option<&LeafPanel> {
    match node {
        PanelNode::Leaf(leaf) => Some(leaf),
        PanelNode::Split(split) => {
            if let Some(remembered_id) = &split.last_active_leaf_id {
                if let Some(remembered) = find_leaf(node, remembered_id) {
                    return Some(remembered);
                }
            }
            edge_leaf(node, fallback_side)
        }
    }
}

/// Find the adjacent leaf panel in the given direction, or `None` if there is
/// no panel that way.
///
/// When entering a subtree, prefers the last-focused leaf within it (via
/// `last_active_leaf_id`), falling back to the nearest edge leaf. `left`/`right`
/// navigate across horizontal splits; `up`/`down` across vertical splits.
pub fn find_adjacent_leaf<'a>(
    root: &'a PanelNode,
    current_leaf_id: &str,
    direction: FocusDirection,
) -> Option<&'a LeafPanel> {
    let path = build_path(root, current_leaf_id)?;

    let axis = match direction {
        FocusDirection::Left | FocusDirection::Right => Direction::Horizontal,
        FocusDirection::Up | FocusDirection::Down => Direction::Vertical,
    };
    let delta: i64 = match direction {
        FocusDirection::Right | FocusDirection::Down => 1,
        FocusDirection::Left | FocusDirection::Up => -1,
    };

    // Walk up the path to the nearest ancestor split matching the axis.
    for entry in path.iter().rev() {
        if entry.node.direction != axis {
            continue;
        }
        let sibling_index = entry.child_index as i64 + delta;
        if sibling_index < 0 || sibling_index as usize >= entry.node.children.len() {
            continue;
        }
        let fallback_side = if delta > 0 {
            EdgeSide::First
        } else {
            EdgeSide::Last
        };
        if let Some(leaf) =
            preferred_leaf(&entry.node.children[sibling_index as usize], fallback_side)
        {
            return Some(leaf);
        }
        // A degenerate (empty) sibling subtree yields no leaf; keep walking up
        // the ancestors rather than aborting, so navigation can still find a
        // reachable pane beyond it (CORE-038).
    }

    None
}

#[cfg(test)]
mod tests;
