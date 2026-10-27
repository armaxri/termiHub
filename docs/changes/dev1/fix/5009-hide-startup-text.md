### Changed

- Nothing is typed into your shell any more to make the file browser follow it (#5009).
  For local shells termiHub reads the shell's current directory from the operating
  system. For SSH sessions it reads it over a separate channel of the same connection
  (`/proc` on Linux, `lsof` on macOS/BSD). There is no setup text at session start, no
  history entry, and no change to your functions, `PROMPT_COMMAND`, `precmd` or `PS1`.
  The MOTD, the login banner and your own startup output show exactly as before.
- Command marks (jumping between prompts, copying a command's output, the
  success/failure marker) now need the opt-in **Command Marks (Shell Hook)** connection
  setting, which is off by default. It still types a small hook into bash/zsh, kept off
  the screen, and its help text lists what the hook leaves behind in the shell.
  PowerShell and cmd keep their startup-argument setup, which is never typed.
- Existing local and SSH connections that still had the hook on from the old default are
  switched off **once** when the connections are loaded after the update. That covers
  connections on the desktop and connections stored on remote agents. Turning the hook
  back on afterwards is kept; the reset never runs again.
