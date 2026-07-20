### Added

- RDP certificate trust management: a new **Security → Remembered RDP
  Certificates** settings section lists the hosts whose RDP server certificate
  you accepted "for host" (#1767) and lets you revoke a single fingerprint or
  forget a whole host, so the next connect prompts again. Backed by new
  `rdp_trust_list` / `rdp_trust_forget` commands over the existing per-host
  trust store (#1784).
