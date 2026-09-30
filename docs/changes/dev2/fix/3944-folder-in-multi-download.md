### Fixed

- **Downloading several items that include a folder downloads the whole folder.**
  A multi-select Download in a remote session's file browser treated a selected
  folder as one file, which failed and could leave an empty file behind. You now
  pick a destination folder for it, and the folder is copied there file by file
  with the usual progress and Transfer Queue rows (#3944).
