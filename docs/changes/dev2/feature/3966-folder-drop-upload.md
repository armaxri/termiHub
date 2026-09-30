### Added

- **Dropping a folder onto a remote session's file browser uploads the whole folder.**
  A dropped folder is now recreated in the current remote folder and copied there file
  by file, with the usual progress toast and Transfer Queue rows. Before, it was treated
  as one file and the upload was refused (#3966).
