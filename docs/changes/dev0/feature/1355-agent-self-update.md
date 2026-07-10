### Added

- Remote agents can now optionally check GitHub for a newer agent build and keep
  themselves current in the background. When the connection's **Allow agent
  self-update** setting is on (#1354; off by default), the deployed agent runs a
  24-hour timer that polls the GitHub `releases/latest` API, compares the
  published version against its own, and — when a newer release exists — notifies
  connected desktops via an `agent.update_available` message (surfaced as the
  self-update toast). When no sessions are active it also downloads the new
  binary, verifies it against its published SHA-256 checksum (fail-closed, same
  rule as desktop deploys in #1350), and stages it, recording the pending update
  in the agent's `state.json`. The whole feature is gated behind the setting: with
  it off nothing is spawned and the agent makes no outbound requests. Any failure
  (no internet, GitHub error, bad checksum) logs a warning and skips the cycle —
  the agent never crashes because of a self-update check. Automatic apply-on-idle
  of a staged update is deferred until the coordinated deferred-apply mechanism
  lands (#1352); for now the agent stops after staging (part of the remote-agent
  update-strategy epic, #1345; #1355).
