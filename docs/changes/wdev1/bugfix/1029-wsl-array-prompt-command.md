### Fixed

- WSL: the file browser now follows `cd /mnt/<drive>` into a native Windows drive
  path (e.g. `C:/`) on distros whose shell exposes `PROMPT_COMMAND` as a bash 5.1+
  array (such as Fedora), instead of settling on the inaccessible `\\wsl$\` UNC root.
  termiHub's OSC 7 CWD hook is now registered as a first-class array element rather
  than overwriting the shell's existing prompt command (#1029).
