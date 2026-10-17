### Added

- **MobaXterm import keeps session logging and scrollback size** (#4881):
  sessions with MobaXterm's "Log terminal output" turned on are imported with
  termiHub's per-connection **Log Session Output** option. termiHub writes
  these logs to its own log folder; a MobaXterm log folder is shown as a note
  in the import preview and is never used. A custom scrollback size becomes the
  connection's scrollback buffer, limited to termiHub's 100–1 000 000 lines.
  Sessions with a custom colour scheme are now read correctly past that
  scheme, so their fixed terminal size is also reported.
