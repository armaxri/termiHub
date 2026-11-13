### Fixed

- The master-password unlock dialog raised by a connect now says which
  connection is waiting on it, for example "Unlock to connect to prod-db (SSH)
  with its saved password." (or "passphrase" for a key). When several connects
  wait, it names the first and counts the rest. The unlock opened from the
  status-bar lock keeps its generic text (#5684).
