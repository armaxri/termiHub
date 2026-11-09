### Fixed

- SSH: a fish login shell on a Windows host (an MSYS2 or Cygwin fish set as the
  OpenSSH `DefaultShell`) now always shows its typed setup line instead of having
  it hidden, which could desynchronise the Windows console; the session's working
  directory is also no longer probed with a script that cannot work there (#5101).
