### Changed

- File browser: a finished transfer is reported in one place. While the Files
  sidebar shows its "N transfers done" line, the status bar no longer repeats
  the count (and the "Downloaded …" toast stays away, #5859); the count comes
  back for transfers of a session the sidebar is not showing. Failures still
  show a toast (#5834).

### Added

- Transfers: a finished download offers "Reveal in Finder" ("Show in File
  Explorer" on Windows, "Open in File Manager" on Linux) beside the Files
  sidebar's transfer line, on its row in the Transfers panel, and on its toast
  when that line is not on screen. It opens the folder holding the downloaded
  file (#5834).
