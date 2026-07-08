# Changes

## Changed

- The shared `Button` primitive now has a first-class `iconOnly` affordance for
  dense icon-only action rows: it squares the control to its height and drops the
  label padding while keeping the ghost skin (color, hover, radius, focus ring,
  and the async pending/success states) from the primitive. Icon-only buttons
  require an accessible name; the primitive warns in the LogViewer when one is
  missing. The tunnel sidebar action row and the Network Tools sidebar monitor
  controls now use this variant instead of component-local geometry overrides,
  so dense icon buttons look and behave consistently across the app. (#1284)
