# Changes — dev1/feature/1242-agent-spawn-feedback-cancel

## Added

- **Cancel an in-progress agent deploy/setup.** The Setup Agent dialog now shows a live setup
  step and a real **Cancel Setup** button while the agent binary is being uploaded and installed.
  Cancelling fires a per-agent cancellation token that aborts the in-flight SFTP upload / script
  injection between steps and rolls back the partially uploaded binary, instead of merely closing
  the dialog while the background transfer runs to completion (via the new `cancel_agent_setup`
  backend command) (#1242).

## Changed

- **Honest feedback for agent tabs that drop while still spawning.** When a remote agent link
  drops while a tab is still opening its session (no session established yet), the tab is now
  parked on the waiting-for-agent path and retries once the agent reconnects, instead of being
  skipped and landing on an ambiguous spawn error. Live-session tabs continue to show the
  reconnecting overlay as before (#1242).
