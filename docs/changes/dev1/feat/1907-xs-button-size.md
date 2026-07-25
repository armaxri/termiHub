### Changed

- UI: the shared `Button` primitive gained a compact `xs` (24px) size. The dense
  sidebar action affordances (Start/Attach/Stop on connection and agent rows,
  the hover Connect button, the inline folder confirm/cancel) and the workspace
  LayoutDesigner schematic buttons now compose the primitive at this size instead
  of hand-rolled CSS, so they pick up the shared focus ring, hover, and
  accessibility handling consistently (#1907).
