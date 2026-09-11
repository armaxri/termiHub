### Changed

- The remote-agent connection editor no longer shows the "Allow agent
  self-update" toggle or the "Deferred" update strategy. Both controls only
  persisted a preference for a mechanism that is not implemented yet, so they
  silently did nothing (WA-FE-002). They will return once the backend lands.
  Existing agent configs that already stored those values keep loading
  unchanged — the values are preserved, just no longer editable.
