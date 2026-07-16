### Added

- Transfer Queue rows now show the remote path (e.g. `/uploads/data.csv`)
  alongside the file name. The backend `transfer-progress` event payload (and the
  `transfer_list` snapshot) now carries a `path` field, populated from both the
  SFTP (#1245) and FTP (#1336) transfer paths, and the frontend maps it into the
  Transfer Queue entry (#1531).
