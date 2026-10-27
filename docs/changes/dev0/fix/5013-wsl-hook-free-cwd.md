### Changed

- WSL sessions no longer type the shell-integration setup at start (#5013). The file
  browser follows the shell's directory by reading it from the shell's process inside
  the distribution, like local and SSH sessions do. There is no `source` line or notice
  at session start, no history entry, and no change to your environment, functions,
  `PROMPT_COMMAND` or `PS1`. Your own startup output shows as before.
- On WSL, command marks now need the opt-in **Command Marks (Shell Hook)** connection
  setting, which is off by default. It still types the visible `source` setup line.
- Existing WSL connections that still had the hook on from the old default are switched
  off **once** when the connections are loaded after the update, on the desktop and on
  remote agents. Turning it back on afterwards is kept.
- If two WSL sessions to the same distribution start within about a second of each
  other, the file browser does not follow that session's directory rather than guess.
