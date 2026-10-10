### Security

- The embedded HTTP server (desktop- or agent-hosted) now caps concurrent
  connections like the FTP server: at most `maxConcurrentSessions` (default 32)
  at a time. A connection beyond the cap is answered with
  `503 Service Unavailable` and closed, and recorded as `busy` in the access log.
  A connection that does not send a complete request header within 30 seconds,
  including an idle keep-alive connection, is closed so it does not hold a slot.
- Failed HTTP Basic-auth logins are now throttled like FTP logins: after 5 failed
  attempts from one client IP within 60 seconds, that IP gets
  `429 Too Many Requests` for 60 seconds without its credentials being checked,
  and the refusal is recorded as `throttled` in the access log. A request without
  credentials (a browser's first request) does not count as a failed attempt, and
  a successful login clears the count.
