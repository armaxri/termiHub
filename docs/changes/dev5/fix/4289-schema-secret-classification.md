### Security

- Connections: every secret a connection type declares in its settings schema
  is now kept out of plain text — not only the field named `password`. The VNC
  SSH-tunnel password (`sshPassword`), password fields of plugin connection
  types and the passwords of inline jump-host hops used to be written in plain
  text to `connections.json`, external connection files, exports and backups.
  They now live in the credential store, are stripped from exports and backups,
  are redacted from logs and diagnostics, and are filled back in when the
  connection connects (#4289).
- Existing plain-text secrets of this kind are moved into the credential store
  the next time the connection file is loaded while the store is unlocked, and
  the file is rewritten without them. The move is all-or-nothing: if the store
  cannot take them, the file is left untouched and the move is retried later.
  With credential storage set to "none", such a secret is no longer persisted
  once the connection is saved again, like connection passwords.
- Plugins: a connection config property marked `"writeOnly": true` is now
  treated as a secret, like one with `"format": "password"`.
