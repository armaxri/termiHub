### Security

- Projection intents and region subscriptions are now bound to the window that
  makes them: a window can no longer act as another window's client id or read,
  mutate, or detach another window's private (client-scoped) regions. Such calls
  are rejected with a typed `client_identity_mismatch` error and logged (TAURI-012,
  #3444).
