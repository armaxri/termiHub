### Added

- **Import from MobaXterm** (#4850): **Settings → Import & Migration** (also in the gear
  menu) imports saved MobaXterm sessions. On Windows termiHub finds the MobaXterm configuration of the
  installed edition (or one in your Documents folder) and previews it at once; on
  every OS you can pick a `MobaXterm.ini` or an exported `.mxtsessions` file. The
  preview shows each session's type, target and folder, lets you choose which to
  import and into which folder, and lists the sessions it cannot import with the
  reason. SSH (with key path and SSH gateways as jump hosts), Telnet, Serial, RDP,
  VNC, FTP, SFTP, local shell and WSL sessions are imported into the same folder
  structure; passwords are never imported.
