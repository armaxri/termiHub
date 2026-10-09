### Fixed

- RDP: "Test connection" now really contacts the server. It used to report success as soon
  as the RDP helper started, even for a wrong host, port or password. It now waits for the
  connection to be established and reports a clear reason when it is not: the host is
  unreachable, the credentials were rejected, the server certificate is not trusted yet, or
  the connection timed out (after the connect timeout, 30 s by default). Cancel still stops
  it at once.
- RDP: connecting to a host that does not answer, or to a service that is not an RDP server,
  now gives up after the connect timeout instead of waiting forever.
- RDP: the RDP helper's log messages and crashes now appear in termiHub's log (Log Viewer,
  `termihub.log` and Export Diagnostics), so a dropped RDP session can be diagnosed. A
  clipboard error that ends the session is now reported as the reason it ended.
