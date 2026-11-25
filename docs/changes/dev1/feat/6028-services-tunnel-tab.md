### Changed

- The tunnel editor looks like the file server's: what to reach, through which server, the port and who
  can open it are on the first screen, and Save is always there (#6028).
- What a tunnel is for is chosen once, under **New service**; the editor can still change it (#6028).
- A new remote tunnel (ssh -R) is open to the SSH server only. Before, it was open to the server's whole
  network. Saved tunnels keep their settings (#6028).
- Who can open a tunnel is chosen in words, with the address that comes out of it and a warning whenever
  others can open it (#6028).
- The way a tunnel goes is under **Show path** (#6028).
- **Save and restart** for a tunnel that runs, and a local tunnel without a name is called like what it
  reaches (#6028).

### Fixed

- termiHub does not say any more that a remote tunnel's port is reachable on the SSH server's network: on
  loopback only the server reaches it, else the server decides (#6034).
