### Fixed

- Terminal control keys (Ctrl+A, Ctrl+C, Alt+B, Ctrl+\, …) now pass through to
  the terminal on non-US/non-Latin keyboard layouts (Cyrillic, Greek, AZERTY,
  AltGr layers, …). The shell-reserved-key detection now matches the *physical*
  key (`event.code`) instead of the produced character (`event.key`), which is
  layout-dependent — so these control combos were previously swallowed as app
  shortcuts when the physical "A" key emitted a non-Latin character.
