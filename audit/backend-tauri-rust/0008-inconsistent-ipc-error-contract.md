---
id: TAURI-008
title: Inconsistent IPC error contract across ~270 commands; TerminalError loses its variant on the wire
angle: backend-tauri-rust
severity: medium
category: arch
is_workaround: false
subsystem: commands / utils/errors
evidence:
  - src-tauri/src/utils/errors.rs:92
  - src-tauri/src/commands/credential.rs:52
  - src-tauri/src/commands/credential.rs:40
  - src-tauri/src/commands/session.rs
status: open
---

## What

The IPC surface has no single error contract. Commands variously return:

- `Result<_, TerminalError>` — the most common (60 `Result<(), TerminalError>` in the sampled
  header alone), a rich enum…
- …but `TerminalError` **serializes to a bare string** (`serialize_str(&self.to_string())`,
  `errors.rs:92-99`), so the variant tag is discarded on the wire — the frontend receives
  `"SFTP error: …"` as an opaque string and cannot branch on `SftpError` vs `SshError` vs
  `Cancelled` without parsing the prefix.
- `Result<_, String>` — 32 `Result<(), String>` + many others (credential, spawn, plugin,
  agent-deploy commands), i.e. genuinely stringly-typed.
- Bespoke structured errors — `UnlockError { message, corrupted }` (`credential.rs:52`),
  `XServerError`, etc. — which *do* give the frontend a machine-readable field.

So three different error philosophies coexist, and the richest one (`TerminalError`) throws its
structure away at the boundary while an ad-hoc struct (`UnlockError`) preserves it.

## Why it matters

The frontend cannot reliably distinguish "user cancelled" from "SSH auth failed" from "session
gone" programmatically — it must string-match on human-readable, localizable prefixes (the repo
already has a regression test, `errors.rs:107`, guarding one such prefix, which is a symptom).
That makes robust error handling (retry vs re-auth vs give up) brittle, and it makes the
contract impossible to evolve without breaking string matches. For a safety-critical UI, error
*classification* should not depend on message text.

## Evidence

- `errors.rs:92-99` — `TerminalError: Serialize` collapses every variant to `to_string()`.
- `errors.rs:107-124` — a test asserting the *string prefix* is `"SFTP error:"` (frontend
  behaviour depends on the message text).
- `commands/credential.rs:40-45` returns `Result<_, String>`; `:94-117` returns
  `Result<_, UnlockError>` (structured). Same file, three error shapes.
- Command-signature census (sampled): `Result<_, TerminalError>` ~95, `Result<_, String>` ~55,
  plus `XServerError`, `UnlockError`, and domain structs.

## Recommendation

Adopt one serialized error envelope for the whole IPC surface: a `{ code: string, message:
string, details?: … }` shape (like `IntentErrorInfo` already used by the projection substrate).
Give `TerminalError` a `Serialize` impl that emits a stable `code` per variant plus the message,
and migrate the `Result<_, String>` commands onto it. Keep the human-readable text for display,
but let the frontend branch on `code`. Aligning on the projection substrate's existing
`{code,message}` convention would make the whole backend speak one error language.
</content>
