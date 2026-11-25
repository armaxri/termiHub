### Added

- Deleting a file server can be undone, its password included (#6076).
- **Keep running** takes back a stop that an offline agent has not got yet (#6076).
- The search of the Services finds what something is for, its technical name and its state: "tunnel",
  "web server", "error" (#6076).
- The status bar says how many services have an error (#6076).

### Changed

- A group of services says its errors and what waits, also while it is closed (#6076).
- An offline agent is said once, with all its tunnels and file servers (#6076).
- The numbers above the services look like what they are, filters, and a filter says how to see all
  again (#6076).
- A new TFTP server asks who can open it: a device never reaches "only this computer" (#6076).
- Deleting a file server says how many connections break, and that the folder and its files stay (#6076).
- A port that another service has is said with its name (#6076).
- Services are listed by name, what needs you first (#6076).
- The kinds of a new file server are called as in the New menu (#6076).

### Fixed

- The status bar does not count tunnels and file servers on removed agents as running (#6076).
