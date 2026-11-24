### Changed

- The crash notice now reads View report and Close, with Close as the main action. Turning
  the notices off is a small "Don't tell me about future crashes" link that says what it
  turns off (#5856).
- An empty window lists up to five of your saved connections, most recently opened first,
  so one click connects. It no longer shows a generic "Open connection…" or a second
  "New connection" button next to the sidebar's (#5856).
- With no saved connections, the empty window offers "Restore from backup…" next to
  "New connection", so starting over after a wipe shows that a restore is possible (#5856).

### Fixed

- Settings ▸ Monitoring no longer says that turning power monitoring off disconnects
  sessions. It only stops the CPU and memory monitor of sessions that use the default; the
  sessions stay connected. The hint now names SSH connections (#5930).
