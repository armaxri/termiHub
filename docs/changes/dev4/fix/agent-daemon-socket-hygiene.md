### Security

- The remote agent now scopes its per-user daemon socket directory by the real
  user id (`/tmp/termihub/uid-<uid>`) instead of the spoofable `USER` env var,
  and no longer falls back to a shared `unknown` bucket when that var is unset —
  so a hostile `USER` cannot redirect the path and two users can no longer
  collide on one directory. On Windows the host-wide registry pipe name is
  likewise derived from the current user's real SID rather than the `USERNAME`
  env var (AGT-020).
- Before binding a daemon/registry socket, the agent now verifies its per-user
  IPC directory is genuinely a directory it owns with `0o700` permissions, and
  that the shared parent is either owned by it or a sticky directory — failing
  closed with a clear error rather than trusting a directory a local attacker
  pre-created or symlinked. This closes a local denial-of-service where squatting
  `/tmp/termihub/<victim>` blocked the victim's persistent sessions (AGT-020).

### Fixed

- The remote agent no longer leaks stale per-session socket and log files. A
  session daemon killed with `SIGKILL` (or that crashes) never gets to clean up
  its `session-<id>.sock`/`.log` files; recovery previously removed only the
  `state.json` entry, leaving the on-disk files to accumulate without bound.
  Recovery now reclaims a dead session's socket, ssh-agent relay socket, and log
  once it has positively determined the session is dead — never touching a live
  session or one another connection still owns (AGT-019).
