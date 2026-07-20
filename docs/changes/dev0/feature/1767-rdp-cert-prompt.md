### Added

- RDP now shows an interactive server-certificate trust prompt instead of hard
  failing on an untrusted certificate. When an RDP host presents a certificate
  that is not yet trusted, a dialog surfaces the host and the SHA-256 public-key
  fingerprint with three choices: accept once (session only), accept for host
  (remembered), or reject. Accepted-for-host fingerprints persist in a per-host
  trust store (`rdp_known_hosts.json`, an SSH `known_hosts` analogue) so the
  host is not prompted again, and a changed fingerprint for a previously-trusted
  host raises a prominent possible-man-in-the-middle warning before offering to
  proceed. `ignoreCertErrors` still accepts unconditionally (#1767).
