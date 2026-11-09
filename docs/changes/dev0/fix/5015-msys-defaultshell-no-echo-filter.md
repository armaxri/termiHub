### Fixed

- SSH: a Windows host whose OpenSSH default shell is Git Bash, an MSYS2 shell or Cygwin is now
  recognised as such, and termiHub's session setup is shown there instead of being filtered out
  of the output, so it can never disturb the Windows console rendering (#5015).
