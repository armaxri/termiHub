### Fixed

- SSH: connecting to an SFTP-only host (one that refuses the shell, e.g.
  `ForceCommand internal-sftp`) no longer ends the session at once. termiHub now
  detects the refused shell, checks that SFTP works, and keeps the connection up:
  the terminal tab shows "This host doesn't allow a shell. Files are available in
  the sidebar." with an **Open Files** button, and the Files sidebar and editor
  work normally, including the read-only "Save a copy" / Download fallback for
  files you cannot write (#4078).
