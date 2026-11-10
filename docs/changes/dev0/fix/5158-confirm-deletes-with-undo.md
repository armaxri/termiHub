### Fixed

- Deleting a connection folder, a custom theme, an idle tunnel, a remote agent,
  an agent's saved connection or an agent folder no longer happens on a single
  mis-click: each now asks for confirmation first. Deleting a connected remote
  agent says that it also disconnects the agent (#5158).
- Folder, theme and tunnel deletes now show an **Undo** button on their toast
  for 10 seconds. Undo restores the folder with its connections and subfolders
  back in place, the theme (re-selected if it was active), and the tunnel
  configuration (#5158).

### Added

- The folder, theme and tunnel delete confirmations have a "Don't ask again"
  box, since those deletes can be undone. Turn the confirmation back on under
  Settings → Safety Prompts → "Confirm before deletes that can be undone"
  (#5158).
