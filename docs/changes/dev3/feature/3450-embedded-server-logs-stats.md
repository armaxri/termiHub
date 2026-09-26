### Added

- Embedded HTTP/FTP/TFTP servers now keep a per-server access log (PROD-034):
  each request records its time, client address, method/command, path, result,
  bytes and duration. FTP logs the login name (never the password); HTTP logs
  only the URL path (never the query string) and the accepted Basic-auth
  username. The log is bounded to the most recent 1000 entries per server,
  survives a stop/start, and shows how many older entries were dropped.
- Detailed per-server statistics (PROD-036): request and error counts, bytes in
  and out, active connections, the most requested paths and most active
  clients, and the transfers currently in flight.
- A new **Show activity** toggle on each server in the Services sidebar (and in
  its context menu) opens the stats panel and a live, filterable access log
  with copy-to-clipboard and clear.

### Fixed

- A TFTP client that starts an upload and then goes silent no longer holds a
  transfer slot and a partial file forever: the upload is abandoned after the
  standard retransmit budget and the partial file is removed.
