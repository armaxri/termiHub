### Fixed

- SSH: on a Windows host whose OpenSSH DefaultShell is cmd.exe, termiHub no longer runs your cmd
  AutoRun an extra time when a session has environment variables, X11 forwarding or Command
  Marks on. It now recognises cmd.exe from the session's own banner instead of running a
  separate command on the host (#5134).
