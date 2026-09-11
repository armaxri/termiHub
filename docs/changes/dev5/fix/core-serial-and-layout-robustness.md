### Fixed

- Serial connections now surface write failures instead of swallowing them. A
  write to a serial port that was unplugged or errored used to vanish silently
  while the tab stayed green and the session kept reporting itself connected; the
  session is now marked disconnected and the disconnect is surfaced (the tab
  leaves the connected state and shows the disconnect overlay), matching how a
  lost serial read already behaved (CORE-018).
- Restoring a saved workspace no longer risks crashing the layout when the
  persisted layout is malformed. A workspace file that was hand-edited, truncated,
  or written by an older build could contain an empty split panel, which crashed
  layout navigation on open; such degenerate panels are now collapsed on restore
  and layout navigation is guarded against them (CORE-038).
