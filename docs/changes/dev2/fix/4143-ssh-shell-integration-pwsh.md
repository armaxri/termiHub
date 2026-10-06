### Fixed

- SSH sessions to a Windows host whose OpenSSH default shell is PowerShell no
  longer lose the first typed command when Shell Integration is on. termiHub
  now asks the host which login shell it runs before setting up shell
  integration: bash, zsh and other POSIX shells get the same setup as before,
  PowerShell gets its own (so the file browser follows its working directory),
  and cmd.exe or an undetected shell gets nothing instead of a POSIX command it
  cannot parse (#4143).
