### Added

- **Services** has a search for both kinds, groups you can close, and **New service** asks what you want
  to do: reach something through a server, let a server reach something here, browse through a server, or
  share a folder (#6028).
- The command palette finds the services by their old words, too (tunnel, server, forward, proxy, share),
  and makes a new one (#6028).

### Changed

- SSH tunnels and file servers are one view, **Services**, with one entry in the activity bar. If you had
  hidden both, it stays hidden; if you had hidden only one, it shows (#6028).
- What has an error or is not known comes first in its group. While the pointer is in the list, no row
  changes its place (#6028).
- The services of an agent that is offline stand under one line, which connects it (#6028).
