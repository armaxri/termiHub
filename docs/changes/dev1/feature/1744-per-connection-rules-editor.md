### Added

- Per-connection terminal settings now have an **"Additional rules for this
  connection"** section under the Syntax Highlighting override. A connection can
  define its own extra highlight rules (add / edit / delete / reorder) using the
  same regex-safety-validated rule editor as the global custom rules. These
  rules are appended after the global rules — they add patterns for that
  connection only and never remove global rules — and persist across restart.
  Clearing the last additional rule while the override is "Use global default"
  removes the per-connection override entirely (#1744, epic #1696).
