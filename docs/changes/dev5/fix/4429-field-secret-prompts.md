### Fixed

- Connections: a secret kept in the credential store other than the main
  password — the VNC SSH-tunnel password, an inline jump-host password or a
  plugin's password field — is now available whenever a connection needs it
  (#4429).
  - Connecting asks to unlock a locked credential store first, then uses the
    saved value.
  - When no value is saved, or credential storage is set to "none", you are
    asked for it in the password prompt. Its "Save" option keeps it in the
    credential store; with storage set to "none" the value is used for that
    connection only.
  - Dismissing the prompt cancels the connect with a message that names the
    missing secret.
  - The connection editor's Test uses the saved values too (it never saves a
    value you type), and saving such a secret to a locked store asks to unlock
    it first.
  - Scheduled runs never ask: they skip a connection whose secret is missing or
    whose store is locked, and say why.
