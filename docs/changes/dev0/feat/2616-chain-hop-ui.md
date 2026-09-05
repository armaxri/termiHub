### Added

- **Chain a hop to this computer** (SSH tunnels): an agent-hosted loopback
  forward whose port only opens on the agent's `127.0.0.1` can now be reached at
  plain `localhost:PORT` on the desktop. On the tunnel editor's reachability
  warning, a new "Chain a hop to this computer" action (beside "Widen bind")
  opens a preview that spells out the companion's three endpoints and its derived
  SSH-via before anything is created; "Create & link" builds a desktop-hosted
  companion `-L` forward whose SSH server is the agent, restoring `localhost:PORT`
  with no new LAN exposure. The action is disabled while the host agent is offline
  and reads "Chained ✓ · reveal" once a companion exists. The companion's SSH-via
  is derived from the user's saved SSH connection that reaches the agent (auto-
  matched by host, overridable in the preview). The linked companion renders
  nested under its parent in the Tunnels sidebar and Open Connections with a link
  badge, its own "this computer" host badge, and a combined "Linked · connected /
  connecting / degraded / down" status; a degraded pair offers an inline Retry /
  "use a different local port" fix. Deleting the parent cascades to the companion
  (the confirmation names both), stopping the companion alone warns it breaks
  `localhost`, and widening or re-hosting the parent flags the now-redundant
  companion for removal (Closes #2597).
