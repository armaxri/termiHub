### Changed

- The remaining sidebar rows now follow the "names, not settings" rule. Settings
  and live details moved into a tooltip on the name:
  - Tunnel rows no longer show the type badge, the port mapping, "via …", the
    host or the traffic counters. Errors, a deleted SSH connection, an
    agent-only bind and a degraded or down chain stay on the row.
  - Service rows no longer show the protocol badge, the port and folder or the
    traffic counters. "Run on" moved from the row into the service editor.
  - Workspace rows show the description as the shared muted line; the tab count
    is in the tooltip. Workspace descriptions are one line of at most 80
    characters.
  - Remote agent rows show the version badge only when the agent needs an
    update; the address and version are in the tooltip. Saved agent connections
    no longer show their session type, and a live session shows a marker only
    when it exited.
  - Recent session rows no longer show the type badge, the last use, the use
    count or "Saved"; a pinned session shows "Pinned".
