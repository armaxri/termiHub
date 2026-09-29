### Added

- When a server rejects a terminal connection's credentials, the tab now offers
  **Update Credentials** (#3089): enter a new password, or a key file and key
  passphrase, and reconnect from the tab without editing the saved connection.
  A **Save** box (preset from the connection's "Save password" setting) stores
  the new secret in the credential store; unticked, it is used for this attempt
  only. A changed host key still shows the usual host-key trust prompt.

### Changed

- Agent-hosted SSH sessions whose server rejects the credentials now stop in
  the same "Authentication failed" state as direct ones instead of retrying a
  doomed login (#3089). The agent protocol is now 0.19.0 (additive: the
  `connection.create` error kind `auth_failed`); older agents and desktops keep
  working as before.
