### Added

- **Stop all services** in the Services sidebar's "…" menu. It asks first only when a connection is open
  (#6028).

### Changed

- Quitting termiHub, and on Windows and Linux closing its last window, asks first when a service has
  connections open, and names each service that stops, also on agents. Before, they stopped without a
  word (#6028).
