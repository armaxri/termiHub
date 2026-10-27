### Fixed

- Local PowerShell and cmd terminals no longer clear the screen when they start, so whatever your PowerShell profile prints at startup and cmd's banner stay visible ([#5017](https://github.com/armaxri/termiHub/issues/5017)).

### Changed

- PowerShell and cmd now start untouched, like bash and zsh: termiHub adds nothing to the session (no wrapped `prompt`, no `$__th_` variables, no `PROMPT` change) unless **Command Marks (Shell Hook)** is turned on for the connection. The file browser still follows cmd's directory. It follows a PowerShell `cd` only with Command Marks on, because PowerShell's location is not the directory the operating system sees ([#5017](https://github.com/armaxri/termiHub/issues/5017)).
