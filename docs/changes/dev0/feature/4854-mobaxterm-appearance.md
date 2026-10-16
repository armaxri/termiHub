### Added

- **MobaXterm import keeps each session's terminal look** (#4854): imported
  SSH, Telnet, serial, shell and WSL sessions now keep their MobaXterm font,
  font size and cursor style (including blinking) as per-connection terminal
  options. MobaXterm's point sizes are converted to termiHub's pixel sizes.
  Telnet sessions also keep their terminal type. Settings termiHub has no
  per-connection counterpart for appear as notes in the import preview: a
  non-UTF-8 character set, custom session colours, a fixed terminal size, or
  a terminal type other than xterm on SSH and local sessions. The same goes for
  MobaXterm's global `[Font]`, `[Colors]` and `[Cursor]` settings. None of
  these are applied silently.
