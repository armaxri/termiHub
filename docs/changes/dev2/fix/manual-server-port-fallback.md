### Changed

- Starting an embedded server (HTTP/FTP/TFTP) on a port that is already in use now
  shows a clear, recoverable message that names the port and explains how to
  recover (stop the conflicting process or choose a different port), instead of a
  bare "address already in use" system error (SM-018).
