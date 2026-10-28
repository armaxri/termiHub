### Fixed

- Keyboard shortcuts that need Shift on a punctuation key now fire from a real
  keyboard. The default New Terminal shortcut (Ctrl+Shift+\` on Windows and
  Linux) did nothing, because the key press reports the shifted character
  (`~`) and the shortcut was compared against `` ` ``.
