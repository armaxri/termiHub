### Fixed

- Typing into a terminal tab right after switching to it no longer garbles the
  typed line. When showing a tab changed its size, keystrokes could reach the
  shell before the new size, so the shell drew the line for the old width and
  part of it overwrote the prompt. Input now waits (for at most a second) until
  the shell has the size the tab shows (#4942).
