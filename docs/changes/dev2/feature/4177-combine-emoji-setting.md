### Added

- Terminal setting **Combine emoji (experimental)**, off by default: when on,
  emoji sequences (ZWJ families, skin-tone modifiers, flags) are laid out as a
  single double-width glyph instead of one glyph per component. Shells that
  count the parts separately may misplace the cursor on such lines, which is
  why it is opt-in. Switching applies to new output in open terminals right
  away (#4177).
