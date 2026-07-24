### Added

- Status bar: a new segment shows how many persistent connections are currently
  running in the background (state `running` or `attached`), giving at-a-glance
  awareness of sessions that have no tab in front of them. It counts both
  desktop-local and agent-hosted persistent sessions, renders an infinity icon
  plus the count with a tooltip, is hidden when none are running, and opens the
  Connections sidebar (where sessions can be attached or stopped) when clicked.
