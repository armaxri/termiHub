### Changed

- Copy/paste of a file between two remote (SFTP-backed SSH) file browsers now
  streams the bytes **directly from source to destination through the desktop**,
  with no local staging file. Previously such a paste downloaded the file to a
  local temp copy and then uploaded it — showing up as two Transfer Queue rows
  plus a local disk round-trip. It is now a single tracked transfer (one queue
  row), pausable/resumable and cancellable like any other, with byte-verified
  offset resume and auto-retry. Cancelling removes the partial destination file.
  Mixed transports (Docker / FTP / remote-agent, or any endpoint without an SFTP
  channel) keep the existing read/write fallback. The copy streams through the
  desktop so it works wherever both hosts are reachable from your machine; a
  server-side host-to-host copy (SCP/rsync) is a possible future alternative
  (PROD-0013).
