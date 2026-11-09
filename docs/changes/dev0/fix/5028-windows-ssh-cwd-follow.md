### Changed

- SSH file browser: the directory of a Windows SSH host is now followed only with the opt-in
  **Command Marks (Shell Hook)** setting, and the setting's help text says so. There is no robust,
  side-effect-free way to follow it without the hook: a PowerShell login shell's location
  (`Set-Location`) is not the directory the operating system sees, and Windows has no supported API
  to read another shell's current directory from outside it. termiHub no longer opens exec channels
  that can only fail for a probed Windows or PowerShell session
  ([#5028](https://github.com/armaxri/termiHub/issues/5028)).
