### Security

- SSH connections now verify the server's host key instead of blindly
  accepting any key. On first contact with an unknown host, a dialog shows the
  key's SHA-256 fingerprint (with host and key type) for confirmation and, on
  "Accept for host", remembers it so the host connects silently thereafter. If a
  previously-trusted host later presents a **different** key, a prominent
  possible-man-in-the-middle warning is shown and the connection is never
  auto-accepted. Hosts already recorded in the user's `~/.ssh/known_hosts` are
  trusted silently. Jump-host hops are each verified. Trusted keys are persisted
  in `ssh_known_hosts.json` in the config directory (#1959).
