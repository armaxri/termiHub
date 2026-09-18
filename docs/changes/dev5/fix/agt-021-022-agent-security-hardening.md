### Security

- The agent now writes its session state file (`state.json`) with owner-only
  (`0o600`) permissions on Unix. The file stores each persisted session's full
  connection settings, so on a multi-user host it must not be readable by other
  local users. The atomic write already yielded `0o600` incidentally; the mode is
  now set explicitly so the guarantee no longer depends on that implementation
  detail. Windows relies on the owner-restricted NTFS ACLs of the `%APPDATA%`
  profile path (AGT-021).
- The agent's local-IPC endpoints restricted to the current user (the session
  daemon and host-wide registry sockets) now verify the connecting peer's user id
  on Unix and refuse connections from a different local user (Linux
  `SO_PEERCRED`, macOS/BSD `getpeereid`). This is defence-in-depth on top of the
  existing `0o700` socket permissions. Same-user connections — including every
  legitimate session reconnect — are unaffected. Windows named pipes rely on
  their existing per-user DACL; the SID-comparison equivalent is deferred
  (AGT-022).
