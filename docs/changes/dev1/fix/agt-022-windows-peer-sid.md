### Security

- The agent session daemon's local-IPC named pipe on Windows now rejects
  connections from a different local user, matching the Unix peer-uid check
  (AGT-022). On a current-user-only endpoint the connected client's SID is
  resolved and compared against the current user's; a positively-different SID
  is dropped and the daemon keeps listening. This is defence-in-depth over the
  pipe's existing per-user DACL. The check fails open on any identity-lookup
  error so a legitimate same-user reconnect is never broken.
