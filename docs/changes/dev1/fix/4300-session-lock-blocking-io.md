### Fixed

- Terminal: one stalled connection no longer freezes every tab. Pasting into a shell
  whose program is not reading input, or typing into a connection whose peer silently
  went away, used to block typing, resizing, opening and closing tabs everywhere until
  that one write gave up. Other tabs now keep working, and the stalled tab can still be
  resized and closed (#4300).
