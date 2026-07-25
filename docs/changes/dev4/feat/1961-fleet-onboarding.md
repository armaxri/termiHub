### Added

- Fleet onboarding: create many saved connections at once from a single
  existing connection used as a **template** (shared type, credentials,
  auth, and jump-host chain), stamping in each host and label. Two sources
  feed it:
  - **Bulk import from a CSV / inventory file** — a new "Onboard hosts from a
    CSV / inventory" action in the connection list reads a file and offers its
    hosts. Accepts a named-header CSV (`host`/`hostname`/`address`/`ip`,
    `label`/`name`, `port`, `user`/`username`, any order), a positional
    header-less CSV (`host,label,port,username`), or a plain host-per-line
    list; `#` comment and blank lines are ignored.
  - **Add scan results as connections** — the Ping Sweep and Port Scanner tools
    gain an "Add as connections" action that onboards the responding /
    open-port hosts through the same template flow.

  Onboarding lands the new connections in a chosen folder and can skip hosts
  that already have a connection there, so re-running a sweep does not create
  duplicates.
