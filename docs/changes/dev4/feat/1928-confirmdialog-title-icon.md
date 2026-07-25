### Added

- Confirmation dialogs now show a tinted accent icon in the title, driven by a
  new `variant` prop on the shared `ConfirmDialog` primitive: `danger` renders
  an alert triangle in the error accent (file-browser delete), `warn` renders
  one in the warning accent (Port Scanner large-scan warning), and a
  caller-supplied `icon` shows on the default variant (a save glyph on the
  Wake-on-LAN "save device" dialog) (#1928).
