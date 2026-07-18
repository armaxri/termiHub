### Fixed

- Transfer Queue: a transfer now settles to its correct final state even when
  its terminal `transfer-progress` event is dropped (e.g. under memory
  pressure). Previously a row seeded at registration (#1632) could stay stuck at
  `queued`/`active` forever if the `done`/`error`/`cancelled` event never
  arrived. The backend now retains recently-terminal transfers briefly and
  includes legacy SFTP transfers in the `transfer_list` snapshot, and the
  frontend reconciles the queue against that snapshot while any transfer is
  in-flight (and on window focus), settling stuck rows without ever regressing a
  live one (#1645).
