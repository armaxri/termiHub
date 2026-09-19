### Security

- When connecting through a remote agent, the per-session daemon no longer
  receives the connection settings — which carry resolved plaintext secrets
  (SSH/VNC/RDP/FTP passwords and SSH key passphrases) — through an environment
  variable. An env var is readable via `/proc/<pid>/environ` by the same user for
  the whole lifetime of the process, so `state.json`'s `0o600` could not cover
  it. The settings are now handed to the daemon over a private stdin pipe
  instead (AGT-021).
- The agent no longer persists connection secrets to disk. Before writing a
  session to `state.json` for recovery, the known secret fields (SSH/FTP/RDP/VNC
  and jump-host `password`, VNC `sshPassword`) are stripped from the stored
  settings. Recovery reattaches to the surviving daemon over its socket and never
  re-handshakes from the persisted settings, so the secret values are not needed
  on disk. User-defined `env`/`envVars` values are intentionally left untouched
  (they cannot be classified as secret) and remain a documented residual.
