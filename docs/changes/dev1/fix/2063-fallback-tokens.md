### Fixed

- Reconciled every `var(--token, <fallback>)` reference whose design token was
  undefined (a follow-up to #2052, which fixed the fallback-less ones). Each
  dangling name was either repointed to the correct current token or backed by a
  newly-defined token, so the affected surfaces (connection editor, terminal
  reconnect/disconnect prompts, SSH/RDP trust dialogs, keyboard-shortcut conflict
  box, recent-sessions popover, connection tree/path dialogs, plugins list, and
  the SSH-config/bulk-import dialogs) now resolve real tokens. A handful of colors
  that had been rendering an ad-hoc fallback now track the theme correctly — dialog
  borders, the plugin focus ring, connection status colors, and the conflict-box
  warning tint all align to the app's semantic tokens. The token-discipline guard
  now also flags fallback-bearing references to undefined tokens, so a fallback can
  no longer mask a stale token rename (#2063).
