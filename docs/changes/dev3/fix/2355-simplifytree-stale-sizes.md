### Fixed

- Split-view: closing or moving a panel no longer mis-sizes the remaining panes
  when the layout had same-direction nested splits. `simplifyTree` hoists a
  nested split's panes into its parent, but was keeping the parent's original
  (now too-short) `sizes` array, so the hoisted panes rendered with wrong widths
  and the sizes stopped summing to 100%. The nested split's size slot is now
  subdivided among its hoisted panes proportionally, keeping `sizes` aligned with
  the panes and summing to 100% (#2355).
