### Changed

- SFTP file transfers (download / upload) now run as a **cancellable, chunked
  copy on a dedicated SFTP channel** instead of buffering the whole file under
  the session lock. Browsing (listing / navigating) the same SFTP session stays
  responsive while a transfer is in flight, and large or mistaken transfers can
  be stopped. Progress and completion are reported via a `transfer-progress`
  event (#1245).

### Added

- **Cancel an in-flight SFTP transfer** — a new `sftp_cancel_transfer` command
  trips the transfer's cancellation token; the copy stops at the next chunk
  boundary and the partial destination file is removed. Cancelling an unknown or
  already-finished transfer is a harmless no-op. On app quit, all in-flight
  transfers are cancelled before SFTP sessions are closed, so no half-written
  file keeps a channel open during teardown (#1245).
