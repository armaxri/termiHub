### Added

- Connecting terminals now have a client-side timeout so they can no longer
  hang forever. A tab **waiting for its agent** to come online settles as
  **Connection failed** after 30s ("Agent did not come online within 30s…")
  instead of parking indefinitely, and a plain connect that never completes
  falls back to a failed state after 60s. Both surface a hint explaining the
  cause with Retry and Cancel, and the waiting overlay now shows a
  "Times out in Ns" countdown so the bounded wait is visible (#1129).
