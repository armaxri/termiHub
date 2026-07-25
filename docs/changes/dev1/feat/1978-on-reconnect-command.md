### Added

- Optional **on-reconnect command** for agentless resilient reconnect (#1978,
  follow-up to #1962): a new per-connection "On-reconnect Command" SSH setting in
  a connection's _Advanced_ settings (shown only when Resilient Reconnect is
  enabled). When a dropped SSH link is re-established by an _automatic_ resilient
  reconnect, termiHub runs the configured command once in the fresh remote shell
  — for example `tmux attach`, `screen -r`, or `cd "$LAST_DIR"` — to recover some
  server-side context an agentless reconnect otherwise loses. It never runs on the
  first manual connect and only while Resilient Reconnect is on. The reconnect
  overlay announces "Will run `<cmd>` on reconnect." while retrying. Empty = off.
