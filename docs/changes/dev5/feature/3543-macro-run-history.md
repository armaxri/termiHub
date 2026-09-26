### Added

- Macros now keep a run history (#3543). Every macro playback — from the Macros
  sidebar, the terminal, the command palette, a workflow's "run macro" step, or a
  schedule — is recorded with its outcome (completed, cancelled, or a target
  terminal disconnected), when it ran and for how long, how many steps were played,
  into which terminals, and what launched it. The **History** panel at the bottom
  of the **Macros** sidebar lists recent playbacks; a macro's **Recent runs**
  action narrows it to that macro, and **Clear history** empties it. Only metadata
  is kept — never what the macro types — for the newest 200 playbacks over the last
  90 days. A scheduled macro's attempt in the Schedules list now links the playback
  it recorded. Like the workflow run history, it is not part of backups.
