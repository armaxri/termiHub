### Added

- **Backup of trusted host keys and plugins** (#3515): the unified backup now includes the SSH
  host keys and RDP certificates you chose to trust, and your installed plugins with their
  settings, signer records and trusted publishers. Both parts are only saved in, and restored from,
  an encrypted backup. Merging host keys never replaces a key you already trust for a host (the
  preview lists those hosts); only Replace adopts the backup's keys. Restored native plugins come
  back turned off and must be trusted again on this computer. Plugins larger than 16 MB (or beyond
  24 MB in total) are left out of a backup with a warning.
