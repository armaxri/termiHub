### Fixed

- Session Picker: reopening the picker no longer briefly shows the targets from
  the previous time it was open. For a moment the old list was shown and could
  be picked, before the picker switched to "Looking for available sessions…"
  and loaded the current list. The picker now goes straight to loading (#4862).
