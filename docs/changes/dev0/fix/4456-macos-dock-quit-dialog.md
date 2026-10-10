### Fixed

- On macOS, quitting from the Dock icon's menu or through AppleScript (`quit app "termiHub"`) now
  asks the same "Quit termiHub?" question as Cmd+Q instead of ending live sessions and discarding
  unsaved editors; logging out, restarting or shutting down still quits at once (#4456).
