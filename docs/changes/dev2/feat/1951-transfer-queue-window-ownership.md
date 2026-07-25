### Changed

- Multi-window: an SFTP/FTP tab's file transfers now **follow the tab** when it
  is moved to another window. The tab's Transfer Queue rows are carried with the
  hand-off and seeded into the destination window's queue, while the source
  window drops them and stops adopting the moved session's later transfers — so
  moving a transfer-bearing tab no longer leaves orphaned or duplicated queue
  entries in the original window (#1951).
