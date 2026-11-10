### Fixed

- SSH: on a Windows host whose OpenSSH DefaultShell is Windows PowerShell or PowerShell 7,
  termiHub no longer loads your PowerShell profile an extra time when a session has environment
  variables, X11 forwarding or Command Marks on. It now recognises PowerShell from the session's
  own banner instead of running a separate command on the host (#5147).
