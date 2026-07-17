### Added

- **`Checkbox` UI primitive** in `src/components/ui/`, a token-styled skin over
  `@radix-ui/react-checkbox`. It complements the existing `Toggle` (a Radix
  `Switch`) rather than replacing it: a checkbox means "takes effect when you
  confirm", a switch means "applies immediately". Real `role="checkbox"`,
  `aria-checked` (including `mixed`), Space activation and focus-visible
  styling come from Radix; the indeterminate state is supported for mixed
  parent/child selections (#1562).

### Changed

- The **Session Picker** footer now draws "Open in new window" and "Remember
  choice" as checkboxes instead of switches, matching the concept mockup. Both
  options only take effect when **Open** is pressed, so a switch overstated
  their immediacy. Behavior is unchanged (#1562).
