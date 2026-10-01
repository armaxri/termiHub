### Fixed

- Remote agents: an SSH connection made **through a remote agent** to an
  SFTP-only host (one that refuses the shell, e.g. `ForceCommand internal-sftp`)
  now stays up for files like a direct connection does: the tab shows "This host
  doesn't allow a shell. Files are available in the sidebar." with an **Open
  Files** button, and the Files sidebar and editor work. This needs the updated
  agent; an older agent ends such a session as before (#4081).
