### Added

- **Paste remote files into a local folder.** Copy or cut files and folders in a
  remote file browser (SSH, FTP, Docker or a remote agent), switch to the local
  disk and paste: they download through the Transfer Queue (with progress,
  pause and cancel) where the connection supports it, folders land with their
  whole tree, and a cut removes the remote originals once they arrived. Pasting
  used to say this was not supported. The sidebar paste and the dual-pane
  transfer view now share one copy engine (#3563).
