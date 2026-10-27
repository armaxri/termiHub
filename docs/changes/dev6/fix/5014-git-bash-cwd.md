### Fixed

- A local Git Bash tab on Windows now follows `cd` in the file browser again with
  nothing typed into the shell (#5014). termiHub read the directory of Git's
  `bin\bash.exe` launcher, which never changes; it now reads the real `bash.exe`
  behind it (and a `bash` started inside it). Virtual MSYS directories such as
  `/proc` keep the last real directory.
- With **Command Marks (Shell Hook)** turned on, Git Bash on Windows gets its hook
  through its environment instead of a typed line, so no setup text appears before
  the first prompt. A `PROMPT_COMMAND` from your profile is kept. Only if your
  profile replaces `PROMPT_COMMAND` outright is the hook typed, as before.
