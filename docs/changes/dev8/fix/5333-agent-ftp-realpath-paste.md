### Fixed

- In an agent session, pasting a file onto itself through a symlinked folder
  is now refused. Before, the copy could empty the file. The same applies to
  pasting a folder into its own subfolder through a symlink. Before, the paste
  copied the folder into itself, and cutting it that way also deleted the
  source together with the copy. The agent now resolves both paths on its own
  host. This needs an agent of protocol 0.36.0 or newer. An older agent still
  catches `.`, `..` and repeated slashes, as before (#5333).
- In an FTP session, a folder pasted into itself through a symlinked folder is
  now refused when the server supports `CWD` and `PWD` (#5333).
