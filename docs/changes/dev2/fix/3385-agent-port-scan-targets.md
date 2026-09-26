### Fixed

- **Port scans on a remote agent now cover every host in a multi-target spec.** A CIDR range
  (`192.168.0.0/24`) or a comma-separated list scanned on an agent was treated as a single host
  name, so it failed or probed nothing. The agent now expands the spec exactly like a local scan,
  with the same limits and errors, and reports results per host ([#3385](https://github.com/armaxri/termiHub/issues/3385)).
