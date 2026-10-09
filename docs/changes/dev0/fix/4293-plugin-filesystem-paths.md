### Security

- Plugin manifests now reject unsafe `filesystemPaths` entries. Before, an
  empty, `.` or relative entry gave a plugin read and write access to the whole
  disk through termiHub. An entry must now be an absolute, normalised path below
  a filesystem root. Empty, relative (`docs`, `~/captures`), `.`/`..`-carrying
  and root entries (`/`, `C:\`, `\\server\share`) fail validation, so such a
  package no longer installs. At load, termiHub also refuses entries that are,
  or contain, your home folder, and entries that overlap termiHub's own config
  or plugins folder.
- The plugin install dialog now lists every folder a plugin asks for, and the
  Settings access summary shows one folder per line. When folders are declared,
  the summary no longer says the plugin has no access to your home folder.
