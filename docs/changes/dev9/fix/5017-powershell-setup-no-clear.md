### Fixed

- Local PowerShell and cmd terminals no longer clear the screen when they start, so whatever your PowerShell profile prints at startup and cmd's banner stay visible. cmd now starts untouched (its own prompt, nothing added) unless Command Marks are turned on; the file browser still follows its directory ([#5017](https://github.com/armaxri/termiHub/issues/5017)).
