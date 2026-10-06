### Fixed

- Windows: inline images (SIXEL, iTerm2) now show in local terminals, not just
  over SSH and Telnet. The installer ships Microsoft's ConPTY host
  (`conpty.dll` + `OpenConsole.exe`, MIT) next to `termihub.exe`, because the
  ConPTY built into Windows drops image sequences. Without those two files, for
  example in a portable copy that leaves them behind, local terminals fall
  back to the built-in ConPTY (#4121).
