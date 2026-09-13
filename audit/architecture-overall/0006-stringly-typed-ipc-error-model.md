---
id: ARCH-006
title: No structured error crosses the IPC boundary — three error families all collapse to display strings
angle: architecture-overall
severity: medium
category: arch
is_workaround: false
subsystem: src-tauri/src/utils/errors.rs, core/src/errors.rs, src/services/api.ts
evidence:
  - src-tauri/src/utils/errors.rs:92
  - core/src/errors.rs:11
  - src/services/api.ts:1262
status: open
---

## What

There are three unrelated error-type families in the stack and none is shared
across the IPC boundary:

- **core** — a clean `thiserror` hierarchy (`CoreError` → `SessionError` /
  `FileError` / `Config` / structured variants like `NotFound`,
  `PermissionDenied`, `LimitReached`) (`core/src/errors.rs:11-88`).
- **src-tauri** — a *different* ~28-variant flat `TerminalError` enum
  (`src-tauri/src/utils/errors.rs:5-81`) that re-flattens core errors into
  `String`-carrying variants (`SshError(String)`, `SftpError(String)`,
  `InternalError(String)`, …).
- **agent** — JSON-RPC numeric error codes (`core/src/protocol`, `agent/src/protocol`).

Crucially, `TerminalError`'s `Serialize` impl throws away all structure:
`serializer.serialize_str(&self.to_string())` (`errors.rs:92-98`). So **every
command error reaches the frontend as a bare display string** — there are no
error codes on the wire. The frontend pattern-matches on message *prefixes*
(there are tests pinning the `"SFTP error:"` vs `"SSH error:"` strings), which is
brittle by construction.

Command return types are also inconsistent: of ~289 command signatures, ~108
return `TerminalError`, **~93 return `Result<_, String>`** directly (no enum at
all), plus a few one-off domain enums (`XServerError`, `UnlockError`,
`ProjectionError`). Roughly a third of commands bypass even the common error
enum.

## Why it matters

- **No machine-readable error contract.** The frontend cannot reliably branch on
  error kind (retryable? auth-failure? not-found?) without string sniffing, so
  error-recovery UX and i18n of error messages are both built on sand.
- **Inconsistency across ~279 commands** means no single place enforces how
  errors are shaped, logged, or localized — a recurring correctness/UX gap on a
  release that must "handle disconnections, reconnections, and errors
  gracefully" (its own reliability quality goal).
- The one domain that did it right (transfers, with a `phase:
  "cancelled" | "error"` discriminant, `api.ts:1262-1297`) shows the shape the
  rest lack — and even that rides the *event* channel, not the command error
  channel.

## Evidence

- `src-tauri/src/utils/errors.rs:92-98` — error → `serialize_str(to_string())`.
- `core/src/errors.rs:11-88` — structured core hierarchy, discarded at the boundary.
- ~93 commands return `Result<_, String>` (grep of `commands/*.rs` signatures).
- `src/services/api.ts:1262-1297` — the lone structured (`phase`) error shape.

## Recommendation

Define one serializable error envelope crossing IPC — `{ code: string, message:
string, details?: … }` — derive `code` from the `CoreError`/`TerminalError`
variant, and map it once at the command boundary. Make `TerminalError`
`From<CoreError>` structurally (preserve the variant/code, not just the string)
and forbid `Result<_, String>` in command signatures via a lint/review rule.
Frontend consumes `code`, never message text. This is the enabling change for
both graceful error recovery and error-message i18n.
