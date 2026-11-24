### Changed

- The Macros and Workflows sidebars now share one History of every macro and workflow run
  (#5818). A row shows the name, a status dot and when the run ended; select it to see who
  started the run, how it ended, how many steps ran and on which terminals.
- Who started a run now reads the same everywhere: "Run by you" (from the sidebar or the
  command palette), "Run by hotkey", "Run by trigger", "Run by schedule" or "Run by another
  automation".
- The History can be narrowed to one macro or workflow, and "Clear…" clears that one's runs,
  or every run, after asking first.
- A macro played on several terminals now gets one History entry per terminal, each with
  its own outcome, as workflows do.
- A macro or workflow that another workflow runs as a step now gets its own History entry,
  "Run by another automation", next to the entry of the workflow that ran it.
