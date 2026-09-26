### Added

- Docker: in **Existing (running) container** mode the connection editor now lists the
  containers of the selected runtime (Auto / Docker / Podman) — running first, stopped ones
  marked — so you can pick one instead of typing its exact name or ID. Typing still works (it
  also filters the list), a refresh button re-queries, and an unreachable runtime shows its
  error without blocking a typed name. Agent-hosted Docker connections keep the typed field
  (PROD-017, #3423).
