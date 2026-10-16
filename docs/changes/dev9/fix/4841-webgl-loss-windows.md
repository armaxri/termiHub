### Fixed

- A terminal no longer gets stuck at a wrong size (for example 2 columns by 1 row) when it is
  resized twice in quick succession, such as right after opening a tab. Programs in the shell now
  always see the size the terminal shows (#4841).
