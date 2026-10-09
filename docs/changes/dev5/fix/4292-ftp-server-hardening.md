### Security

- The embedded FTP server (desktop- or agent-hosted) now caps concurrent sessions
  at 32 by default. A connection beyond the cap is answered with
  `421 Too many connections` and closed, and recorded as `busy` in the access log.
  The cap is configurable per server via the new `maxConcurrentSessions` setting
  (CORE2-002).
- FTP usernames and passwords are now compared in constant time, like the HTTP
  server's Basic auth. After 5 failed logins from one client IP within 60 seconds,
  that IP is refused for 60 seconds: new connections get
  `421 Too many failed logins` and further login attempts are denied without
  checking the credentials. The count is server-wide, so reconnecting does not
  reset it, and the tracking table is bounded to 1024 client IPs (CORE2-003).
