### Changed

- Deleting an SSH tunnel now gives clear feedback: a loading toast while the
  delete runs, then a success toast, or a recoverable error toast if the backend
  delete fails (previously failures were swallowed silently and could leave the
  tunnel list out of sync with the backend). Deleting a tunnel that is currently
  active (connecting, connected, or reconnecting) now asks for confirmation
  first, since it tears down a live connection. Addresses GAP 7 of the SSH tunnel
  audit (#1141).
