### Added

- SSH connections now have an **Initial Command** setting in their _Advanced_
  settings, like local shell and WSL connections (#4866). The command runs once
  in the remote shell after the first connect (after Shell Integration has been
  set up, when enabled), for example `tmux attach` or `cd /srv`. It also works
  for SSH connections hosted on a remote agent. An automatic reconnect does not
  run it again; the On-reconnect Command covers that case.
- The MobaXterm importer maps an SSH session's "Execute command" onto the new
  Initial Command setting instead of only listing it as a preview note.
