### Changed

- Settings ▸ Safety prompts: one "Ask before closing a live session" choice
  (Always, Only for keyboard shortcuts, Only for mouse closes, Never) replaces
  the two overlapping close toggles, so it is clear what happens on Cmd/Ctrl+W.
  Your earlier choices carry over unchanged, and "Don't ask again" in the close
  dialog only stops asking for the kind of close you just made (#5844).
- Settings ▸ X server: the hint under "Provide X server automatically"
  describes only your platform, and "Stop X server when idle" sits under it.
  While termiHub does not provide the X server, the idle stop is greyed out and
  shows off; your setting comes back when you turn providing on (#5844).
- Settings ▸ Serial: off Linux, the "n / m enabled" prefix count is gone (the
  prefix scan only runs on Linux), and a note says baud rate, data bits, parity
  and flow control are set on each serial connection (#5844).
- The persistent-session notice on closing a tab now follows only its own
  setting, also for the keyboard shortcut, as its description already said
  (#5844).
