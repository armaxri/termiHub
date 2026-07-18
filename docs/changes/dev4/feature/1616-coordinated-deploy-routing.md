### Added

- Remote agents set to the **Coordinated** update strategy now route the
  desktop-push **Update** (deploy) through the coordinated path, not just the
  agent's "Apply Now" self-update banner (#1602). On a **Unix** agent the new
  binary is staged (uploaded without installing) and handed to
  `agent.request_update`, which broadcasts `agent.update_pending` to every other
  connected host, gives them a clean disconnect + auto-reconnect window, and
  self-applies — no more hard-cutting other hosts on an Update. The Update dialog
  reports how many hosts were notified and whether the apply was immediate or
  deferred until the agent's last session disconnects (#1616).

### Changed

- `Coordinated` is now an active update strategy (previously saved-only). A
  coordinated Update on a **Windows** agent falls back cleanly to the existing
  immediate deploy (shutdown + redeploy, connected-host guard intact), because
  the agent's apply-from-path self-swap is Unix-only. Non-coordinated
  (Immediate / Deferred) updates are unchanged (#1616).
