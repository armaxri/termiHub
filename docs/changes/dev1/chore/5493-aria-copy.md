### Changed

- Screen-reader names, tooltips and error titles now use sentence case: the terminal toolbar
  ("New terminal", "Split terminal right", "Record macro", "Broadcast input", "Close panel"),
  the terminal search toggles ("Match case", "Match whole word", "Use regular expression"),
  agent connection errors ("Authentication failed", "Could not reach host", "Agent not
  installed"), the cheat sheet save dialog and the workspace editor's "Local shell" tab. The copy
  lint now checks `aria-label`, `title`, tooltip text and error/dialog titles too (#5493).
