### Added

- Multi-window foundation (#1900, epic #1899): the backend can now create a
  second native window and a live session tab can be moved between windows
  without restarting its backend session (PTY / SSH / serial keeps running).
  This lands the core seam the rest of the epic builds on:
  - A backend `session_id → owning_window` ownership map with a claim/release
    handshake, so a session renders in exactly one window at a time, plus resize
    ownership so only the displaying window drives a PTY's size.
  - Window creation/labelling (`win-N`) and a per-window tab hand-off queue, via
    new commands `open_window`, `claim_session`, `release_session`,
    `get_session_owner`, `list_windows`, `take_pending_handoffs`,
    `send_handoff_to_window`, and `replay_session_scrollback`.
  - Per-session 1 MiB scrollback capture so a re-parented view repaints history
    in the destination window (works for any session type, including plain local
    shells which have no backend replay buffer of their own).
  - A frontend `moveTabToWindow` store seam (new or existing window), hand-off
    hydration on window boot / on a live `window-handoff` nudge, and destination
    scrollback replay into a fresh xterm.

  The "Move to Window" commands/menus (#1901), empty-window state (#1902),
  close-with-live-tabs decision (#1903), graphical-tab move (#1904), and
  window-dimension persistence (#1905) are separate follow-up children and are
  not part of this foundation.
