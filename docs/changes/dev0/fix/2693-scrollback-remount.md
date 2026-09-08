### Fixed

- Rearranging a terminal panel no longer wipes that terminal's scrollback.
  Dragging a tab to a panel edge or centre, moving it across panels, or moving
  it to another tab group reparents the terminal's DOM element into a
  freshly-created panel that may not be laid out yet. The adopt-time (and
  visibility) re-fit measured that ~0-sized container, so `FitAddon` proposed
  its ~2-columns × 1-row minimum and the xterm — and its PTY — were resized that
  narrow, destructively reflowing the buffer: the history was mangled into
  2-column garbage and the shell redrew, leaving only the shell-integration
  setup line. The backend session was alive the whole time; only the on-screen
  buffer was lost. Terminal fits now skip any container below a minimum size and
  let the resize observer re-fit once real layout dimensions land, so the live
  scrollback survives every layout op (#2693).
