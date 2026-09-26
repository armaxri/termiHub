### Fixed

- Terminal: **OSC 133 command marks survive a reconnect, a tab moved to another
  window and a window reclaim.** Jump to Previous / Next Prompt reaches the prompts
  from before, and their green/red status marks reappear. The marks are saved with
  the preserved scrollback and rebuilt after it is restored; when the scrollback is
  repainted from the session's buffer the marks are rebuilt from it without
  duplicates. A shell `reset` now also clears the marks (#3420).
