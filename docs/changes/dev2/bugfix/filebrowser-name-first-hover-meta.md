### Fixed

- **File browser rows** (regression from #2798):
  - File names are shown in full again and are never truncated. A name wider than
    the panel is reachable via horizontal scroll, with the row tooltip as a
    guaranteed-readable fallback.
  - Size and Modified now reveal on hover as a right-edge overlay instead of
    crowding the name onto a cramped second line.
  - Restored the file-list scrollbar — the list scrolls vertically again.
