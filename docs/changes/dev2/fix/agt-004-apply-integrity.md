### Security

- Remote-agent updates are now integrity-verified at the moment they are
  applied, on every route (coordinated desktop push, "Apply Now", self-update,
  and any staged-then-applied-later retry). The agent re-computes the SHA-256 of
  the staged binary immediately before swapping it in and refuses to apply
  anything whose bytes do not match the digest the initiator intended — closing a
  time-of-check/time-of-use window where a local user with write access to the
  staging path could swap the file between staging and apply. A missing digest,
  an unreadable file, or a mismatch all **fail closed** (no copy, no re-exec). The
  desktop now sends the SHA-256 of the binary it uploads for a coordinated push,
  and the self-update path threads the digest it downloaded through to apply
  (AGT-004). This composes with the existing staging-path confinement (AGT-003):
  both guards run before the swap. Cryptographic signature/authenticity
  verification remains a separate, deferred change (AGT-005 / SEC-006).
