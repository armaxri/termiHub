### Fixed

- Narrow tabs now keep the part of their name that tells them apart: a title is
  shortened in the middle, so the end of the name and the duplicate counter
  ("(2)") always stay visible. The full name is still in the tab's tooltip, and
  a serial tab's tooltip also names its port.
- A second session of the same connection now opens right next to the first
  one instead of at the end of the tab strip.
- The "Unencrypted" marker on telnet tabs is now a compact open-lock icon (named
  "Unencrypted" for screen readers and in its tooltip), so it no longer squeezes
  the connection name. The status bar keeps the "Unencrypted" text badge.
