### Added

- **MobaXterm import brings your trusted SSH host keys** (#4852): the MobaXterm
  import preview now lists the SSH host keys MobaXterm has accepted, with their
  fingerprints. Tick **Also import N trusted host keys** to have termiHub trust
  them, so an imported SSH session connects without a first-connect host-key
  prompt. The step is off by default. A key is never imported when termiHub (or
  your `~/.ssh/known_hosts`) already trusts a different key for that host, and
  malformed entries, obsolete DSA keys and host names that are patterns or lists
  are skipped; the preview shows each skipped key with the reason.
