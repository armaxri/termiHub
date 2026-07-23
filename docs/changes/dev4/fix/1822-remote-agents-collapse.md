### Fixed

- Connections sidebar: collapsing the **Remote Agents** group now folds its
  contents away and reclaims the sidebar space, matching the Connections group.
  Previously the group's children were hidden on collapse but the wrapper kept
  its flex-grow slot, so an empty gap remained "giving free view over the side
  bar" instead of increasing visibility of the other groups. The group toggles
  also expose `aria-expanded` now (#1822).
