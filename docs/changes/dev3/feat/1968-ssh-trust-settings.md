### Added

- SSH host-key trust management: a new **Security → Remembered SSH Host Keys**
  settings section lists the hosts whose SSH host key you accepted "for host"
  (#1959) and lets you revoke a single fingerprint or forget a whole host, so the
  next connect prompts again. The SSH analogue of the RDP certificate trust UI
  (#1784), backed by the existing `ssh_trust_list` / `ssh_trust_forget` commands
  over the per-host SSH trust store (#1968).
