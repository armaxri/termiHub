### Added

- File servers are edited in a tab, like tunnels: unsaved changes are asked about, a draft moves with its
  tab to another window, and the tab can stand beside a terminal (#6028).
- **Save and start** for a file server, and **Save and restart** for one that runs (#6028).
- The editor shows the address that others will type (#6028).

### Changed

- A new file server is download only, until you allow uploads. Saved servers keep their settings (#6028).
- Whenever others can reach a file server, its editor says who, and what they can do without a password.
  Before, only 0.0.0.0 asked once (#6028).
- A file server on an agent is opened to an address you type, not to one of this computer (#6028).
- "Ask for a password" needs a user name and a password before it can be saved (#6028).

### Fixed

- A long value in a select box is cut with dots, instead of running over its box (#6028).
