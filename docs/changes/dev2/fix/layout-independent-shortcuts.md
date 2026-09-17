### Fixed

- Keyboard shortcuts now match the physical key rather than the produced
  character, so `Ctrl`/`Cmd`+letter and `Cmd`+digit shortcuts fire on the same
  physical key on non-US / non-Latin keyboard layouts (e.g. Cyrillic, AZERTY,
  Dvorak) instead of failing to fire or firing on the wrong key (I18N-011).
