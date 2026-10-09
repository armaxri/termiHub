### Fixed

- Closing a tab group from its chip X or its "Close Group" menu item now asks
  for confirmation when the group still has live sessions or unsaved editors,
  like closing a single tab or a panel already did. "Don't ask again" applies
  to live sessions; unsaved editors always ask (#4306).
- Launching a saved workspace from the command palette, or by starting
  `termihub --workspace` a second time, now asks before closing your open
  sessions, the same way launching it from the Workspaces sidebar does (#4306).
