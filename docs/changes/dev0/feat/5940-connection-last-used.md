### Changed

- The empty window's Recent connections now ranks each saved connection by
  when it last connected, so two saved connections to the same host no longer
  share one place in the list. termiHub records the time on each successful
  connect; it is never shown in the sidebar. Existing connections start as
  never used and fall back to the session history until you open them again.
  Connections in external connection files are not rewritten on connect.
- Remote agents (protocol 0.43.0) record when each saved agent connection was
  last used. Older agents and desktops keep working unchanged.
