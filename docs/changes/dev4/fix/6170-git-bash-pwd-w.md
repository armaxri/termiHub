### Fixed

- On a Windows SSH server with Git Bash (or MSYS2, Cygwin) as its login shell, the file browser
  now also follows `cd` into MSYS mounts such as `/tmp` or `/usr`: the shell reports the
  Windows folder they point to (`/tmp` → `C:/Users/<you>/AppData/Local/Temp`). Hosts without
  `pwd -W` or `cygpath` report the path as before (#6170).
