### Fixed

- Pasting a file onto itself in the same SSH, Docker or agent session is now
  refused. Before, a streamed copy could empty the file while it was read, also
  when the destination was the same file under another spelling (`dir/./f`,
  `..`) or through a symlink (#5330).
- Pasting a folder into itself or into one of its subfolders in the same FTP or
  agent session is now refused instead of copying it into itself without end.
  The source folder is also listed in full before anything is created, so a
  path the server cannot resolve still copies the folder only once (#5330).
