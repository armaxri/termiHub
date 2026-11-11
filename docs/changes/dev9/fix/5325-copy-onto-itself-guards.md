### Fixed

- File browser: copying a file onto itself on the local disk or on an
  agent-hosted session no longer risks emptying it, and copying a folder into
  itself (or into one of its subfolders) no longer recurses until the path is
  too long. Both are now refused before anything is written, with "copy … to …
  refused: source and destination are the same file" or "… the destination is
  inside the source folder". Respelled paths (`dir/./f`, `..`), symlinks and
  hard links to the same file are caught too (#5325).
