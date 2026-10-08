---
id: DUP2-001
title: "Desktop finds connection secrets by the literal key `password` only, so the VNC SSH-gateway `sshPassword` (and plugin `format: password` fields) are written in plaintext to connections.json, external files and backups"
angle: code-duplication
severity: medium
category: security
is_workaround: false
subsystem: "src-tauri connection storage / secret classification (core schema, agent, log redaction)"
evidence:
  - src-tauri/src/connection/manager.rs:34-76
  - core/src/backends/vnc/config.rs:117
  - core/src/backends/vnc/config.rs:588-594
  - core/src/plugin/connection.rs:248-251
  - src-tauri/src/backup/sections.rs:270-300
  - agent/src/state/persistence.rs:161-165
  - agent/src/state/persistence.rs:184-205
  - core/src/protocol/log_frame.rs:119-165
  - core/src/diagnostics/redact.rs:51
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

There is no single source of truth for which settings keys hold a secret. Each layer keeps its own hand-written list. (1) Desktop save path `prepare_for_storage` (manager.rs:53-76) moves only `settings["password"]` to the credential store and removes only that key; its doc comment says it strips 'the password field so it is never written to disk'. (2) Backup export `strip_connection_passwords` (sections.rs:274-300) also removes only `password`. (3) The agent's at-rest redaction uses its own list, `SECRET_SETTINGS_KEYS = ["password", "sshpassword"]` (persistence.rs:165), applied recursively. (4) Log redaction has a third list (`is_secret_field`, log_frame.rs:119) and diagnostics a fourth regex (redact.rs:51). The schemas themselves declare secrets as `FieldType::Password` under other keys. The VNC SSH-tunnel group has `sshPassword` (vnc/config.rs:594, the gateway password or key passphrase), and plugin connection types turn any `format: password` property into `FieldType::Password` under any key (plugin/connection.rs:248-251). The agent's list already knows `sshPassword` (AGT-021 fix). The desktop's does not, and no desktop code mentions `sshPassword` (only one test fixture).

## Why it matters

A direct VNC connection that uses an SSH tunnel with a password keeps `sshPassword` in its settings. The desktop does not route it to the keychain or vault and does not strip it, so it is serialized in plaintext into connections.json. That includes external connection files, which are meant to be shared with a team, and backup exports, which strip only `password`. This breaks the app's own rule that secrets live only in the credential store. The duplication is the cause: the agent fixed this key in its copy of the list, but the desktop copy never got it.

## Recommendation

Make the schema the single classifier. Add `core::connection::secret_keys(schema) -> Vec<String>`, or a recursive `strip_secret_fields(schema, &mut settings)`, driven by `FieldType::Password`, with a static fallback list (`password`, `sshPassword`) for schema-less callers. Use it in `prepare_for_storage` (routing each secret to the credential store under a per-key CredentialType or owner suffix, or at least stripping it), in `strip_connection_passwords`, and in the agent's `redact_persisted_secrets`. Add a desktop regression test that saves a VNC connection with `useSshTunnel` and `sshPassword` and asserts the key is absent from connections.json and from a backup export. Add a migration that moves or strips any `sshPassword` already on disk.

## Verification

I confirmed this from the code at develop 663465d52. I found no guard that the first auditor missed.

- **Desktop save path:** `prepare_for_storage` (src-tauri/src/connection/manager.rs:43-79) only reads, routes and removes `settings["password"]`. Every save path calls it: `save_connection`, `save_connection_routed` (which covers external files) and the import/bulk paths at lines 842, 883 and 1101.
- **Frontend:** the `stripPassword` pre-persist strip in src/store/slices/connectionTreeSlice.ts:116-132 also touches only `password`.
- **Backups:** `strip_connection_passwords` (src-tauri/src/backup/sections.rs:275-303) removes only `password`.
- **The VNC schema:** it declares `sshPassword` as a `FieldType::Password` that shows whenever the tunnel is on (core/src/backends/vnc/config.rs:588-594). The doc comment calls it the gateway password or key passphrase. The schema-driven form therefore sends it in settings.
- **Nothing else handles the key:** `sshPassword` appears nowhere in src/ or in src-tauri non-test code. Only the agent's `SECRET_SETTINGS_KEYS` knows it (AGT-021 / #3112, which covered the agent's state.json only).
- **No deliberate decision:** I found no ADR or audit decision accepting plaintext `sshPassword` on the desktop. The AGT-021 resolution treats the key as a secret.

So a tunnelled VNC connection with password or passphrase auth writes `sshPassword` in plaintext to connections.json, external (team-shareable) connection files and backup exports. The duplicated key lists are the cause. The plugin `format: password` part holds in principle, but I did not trace a concrete plugin that uses it.

I rate it medium, not high. It needs one specific configuration (VNC over an SSH tunnel with password or key-passphrase auth). The file belongs to the local user, and the secret is the user's own credential. The worst case is sharing it through an external file or a backup.
