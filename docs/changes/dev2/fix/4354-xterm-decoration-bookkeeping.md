### Fixed

- Syntax highlighting keeps working in long sessions: once the scrollback was
  full, newly printed lines were no longer highlighted and the highlight on the
  line just written disappeared on the next write. Highlights now stay correct
  however much output scrolls past.
- Command marks (OSC 133) stay bounded: a shell re-emitting prompt marks on one
  line no longer piles up command records and gutter marks, and the number of
  tracked commands is capped at 10,000.
