### Added

- **Coordinated agent updates.** A desktop can now ask an agent to update via the new
  `agent.request_update` method (protocol 0.4.0), and the agent warns every **other** desktop
  attached to the same host with an `agent.update_pending` notification before swapping its binary.
  Each notified desktop gets up to 10 seconds to close its sessions and disconnect cleanly; the
  agent proceeds as soon as they have all gone. Previously the only way to update an agent used by
  several hosts was to cut the others off without warning.

  Disconnecting _is_ the acknowledgement, so a desktop that has crashed or that ignores the notice
  cannot hold an update hostage — when the window closes the update proceeds anyway and reports
  which hosts were still attached. Active sessions are never interrupted: the update is applied
  through the existing deferred-apply path, so it still waits for the last session to end, and
  sessions themselves survive the swap in their detached daemons.

  Coordination degrades rather than blocks: on a host where the registry daemon is unavailable the
  update proceeds immediately, exactly as it did before this change.

### Changed

- **Agent protocol version is now 0.4.0** (additive). Desktops older than 0.4.0 never receive the
  `agent.update_pending` notice and so are still hard-cut when another host updates the agent —
  they are not broken, only unwarned, which is why the agent proceeds on a timeout rather than
  waiting for an acknowledgement such a desktop could never send.
