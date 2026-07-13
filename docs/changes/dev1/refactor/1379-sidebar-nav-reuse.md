### Added

- Keyboard navigation and ARIA tree semantics for the Tunnels, Workspaces, and
  Remote Agents sidebars, matching the Connections tree (#1356). Each list is now
  a `role="tree"` with `role="treeitem"` rows and roving-tabindex focus: arrow
  keys move between rows, Home/End jump to the ends, type-ahead jumps by name,
  and Enter activates the focused row (edit a tunnel, launch a workspace, or open
  the focused agent connection). Mouse behavior is unchanged.
- A search filter in the Remote Agents section header that narrows each agent's
  saved connections by name and auto-expands matching folders, mirroring the
  Connections filter (Escape clears it).
