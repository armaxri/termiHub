### Added

- Connections panel search and keyboard navigation (#1356): a filter box pinned
  in the Connections header live-filters the tree by connection name or host,
  auto-expands folders that contain a match, connects the top hit on Enter, and
  clears on Escape. The tree is now fully keyboard-operable with roving-tabindex
  arrow navigation (Up/Down move, Right expands or descends, Left collapses or
  ascends, Enter/Space connects the focused connection or toggles a folder,
  Home/End jump to the first/last row) and correct ARIA tree semantics
  (`role="tree"`/`treeitem"`/`group"` with `aria-expanded`). Each connection row
  also surfaces a hover/focus "Connect" affordance beyond the native tooltip.
