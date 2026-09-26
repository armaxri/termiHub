### Added

- File browser: drag files and folders out of the window onto the desktop, Finder,
  Explorer or a Linux file manager to save a copy there. Local rows drag their real
  files; SFTP / FTP files are first downloaded through the Transfer Queue (with
  progress and cancel) into a private temporary folder, then handed to the OS drag —
  if the download finishes after you let go, drag the file out again and it starts
  instantly. Temporary copies are removed after 10 minutes and when termiHub quits.
  Remote folders and Docker / agent sessions are not supported yet (use Download)
  (#3457).
