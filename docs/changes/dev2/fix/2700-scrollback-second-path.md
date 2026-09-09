### Fixed

- Dragging a terminal panel across to another panel (cross-panel move) or onto
  a window edge (drag-to-edge) no longer wipes that terminal's scrollback.
  Building on #2697, a second path could still slip a degenerate resize
  through: during the reparent the destination panel is briefly laid out at
  full height but near-zero width, and xterm's fit computed a 2-column size
  (it reserves scrollbar width before dividing, so even a 10-30px-wide slot
  clamps to the minimum) — which reflowed the live buffer into 2-column garbage
  and made the shell redraw its prompt, losing history. termiHub now guards
  fits on the _proposed_ terminal dimensions (the value that actually reaches
  the PTY), skipping any fit that would clamp below a usable column count and
  re-fitting once the panel reaches its real size (#2700).
