### Fixed

- **Automations written by a newer termiHub are no longer damaged** (#6009): saving any automation used
  to drop settings this version does not know, and an automation with a step of an unknown kind was
  removed from the list as corrupt. Everything is now kept as it was, through editing, renaming,
  duplicating, the Armed switch, connection renames, and backup and restore. An automation that this
  version cannot read at all stays in the file and is named in a warning at start.
- An automation with a step this version does not know is refused before anything is typed. Before,
  the run stopped in the middle, or skipped the step when it was set to continue on failure.
