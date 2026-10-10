### Security

- Embedded FTP server: a connection that does not log in within 30 seconds is now
  answered with `421` and closed, and one client address can hold at most a quarter
  of the session slots (at least 2). An idle or misbehaving client can no longer
  occupy every slot and lock other clients out (#4398).
