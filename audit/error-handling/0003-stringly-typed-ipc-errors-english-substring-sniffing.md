---
id: ERR-003
title: Error type/variant is erased at every IPC boundary; frontend re-derives category by matching English substrings
angle: error-handling
severity: high
category: reliability
is_workaround: true
subsystem: src-tauri/src/commands, src/utils/classifyAgentError.ts, core/src/errors.rs
evidence:
  - src/utils/classifyAgentError.ts:25
  - src/hooks/useConnectSavedConnection.ts:168
  - core/src/errors.rs:34
  - src-tauri/src/commands
status: in-progress
resolution: "#2742 — auth-failure typed; broader stringly-IPC-error rewrite separate"
---

## What
`core` has a clean, typed error taxonomy (`CoreError`/`SessionError`/`FileError` with `thiserror` variants like `NotFound`, `PermissionDenied`, `SpawnFailed`, `LimitReached`, `NotRunning` — `errors.rs:34`). **All of that structure is thrown away at the IPC boundary.** Tauri commands return `Result<T, String>` (109 such signatures in `src-tauri/src/commands` alone; ~270 commands total per prior threads), and the typed error is flattened via `map_err(|e| e.to_string())` (75 sites in `commands/`). The frontend receives an opaque string.

The frontend then tries to **recover the lost type by string-matching English prose**:

- `classifyAgentError.ts` decides `unreachable` / `auth-failure` / `agent-missing` / `agent-outdated` / `already-connected` purely by `raw.includes("Connection failed")`, `raw.includes("auth failed")`, `raw.includes("Exec failed")`, `raw.includes("Read initialize response")`, `raw.includes("Initialize rejected")`, `raw.includes("is already connected")` (lines 25–77). Anything unmatched falls through to `"unknown"` and dumps the raw string at the user.
- `useConnectSavedConnection.ts:168` re-implements the same auth-failure sniff (`errStr.toLowerCase().includes("auth failed") || errStr.includes("Authentication failed")`) to decide whether to **discard a stored credential** (ux-flows 0013). A destructive decision keyed on a substring of a backend log message.
- `AgentUpdateBanner.tsx:28` sniffs `raw.includes("timeout")`.

## Why it matters
- **Brittle and silently degrading.** Any reword of an error string *anywhere* in the SSH→agent→command chain — a russh upgrade, a message tweak, an i18n pass — silently reclassifies real errors as `"unknown"`. The user stops getting the actionable "Agent Not Installed / re-deploy" guidance and instead gets a raw string. Nothing fails loudly; the classification just rots.
- **Locale/​i18n-fragile.** The matching assumes English, forever. It cannot survive localization of backend errors and will misfire if any layer localizes.
- **Correctness of a destructive action depends on prose.** `useConnectSavedConnection` deletes a saved credential when it *guesses* the failure was auth — a wrong guess (or a changed string) either wipes a good credential or keeps a bad one.
- This is the error-propagation-quality root that `backend-tauri` noted at a high level; here it is traced end-to-end to the two concrete decision points that act on the sniffed category.

## Evidence
- `core/src/errors.rs:34` — rich typed variants exist.
- 109 `Result<_, String>` signatures in `src-tauri/src/commands`; 75 `map_err(|e| e.to_string())` in `commands/`.
- `src/utils/classifyAgentError.ts:25–77` — six English-substring branches → else `"unknown"`.
- `src/hooks/useConnectSavedConnection.ts:168–172` — substring sniff gates `removeCredential(...)`.

## Recommendation
Serialize a **typed, stable error envelope** across IPC instead of a bare string: `{ code: "auth_failed" | "unreachable" | "agent_missing" | ..., message, details? }`, derived from the `thiserror` variant (a `#[serde] enum` or a `code()` method on the error). The frontend switches on `code`, never on `message`; `message` remains only for display. This deletes `classifyAgentError`'s substring ladder and makes the credential-discard decision deterministic. Do it once at the command-result boundary so all ~270 commands benefit. Mark the substring sniffs `is_workaround` until replaced.
</content>
