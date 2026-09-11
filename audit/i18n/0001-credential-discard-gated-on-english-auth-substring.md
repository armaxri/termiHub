---
id: I18N-001
title: Destructive credential discard is gated on an English "auth failed" substring
angle: i18n
severity: critical
category: bug
is_workaround: false
subsystem: src/hooks/useConnectSavedConnection
evidence:
  - src/hooks/useConnectSavedConnection.ts:166
  - src/hooks/useConnectSavedConnection.ts:168
  - src/utils/classifyAgentError.ts:35
status: in-progress
resolution: "#2742"
---

## What
When a saved connection is opened with a stored credential and the pre-connect
attempt throws, the code decides whether to **delete the stored credential** by
matching the error string against the English literals `"auth failed"` /
`"Authentication failed"`:

```ts
} catch (err) {
  const errStr = String(err);
  if (
    errStr.toLowerCase().includes("auth failed") ||
    errStr.includes("Authentication failed")
  ) {
    // Stale credential — remove it and fall through to prompt
    await removeCredential(connection.id, resolution.credentialType).catch(() => {});
  } else {
    // Non-auth failure — let the Terminal component handle the error
    openTab(config, { ... });
    return;
  }
}
```

The branch that fires on a match performs a **destructive** action
(`removeCredential`) — it discards the user's saved password/passphrase. The
gate is a locale-sensitive English substring test.

## Why it matters
This is bucket A (a bug that exists today) on a safety-relevant path:

- The classification is **wrong under a non-English locale**. The error text
  originates from the SSH stack / remote host (libssh2 / OpenSSH / the agent).
  If the remote or the transport emits a localized authentication-failure
  message (or the message wording is refactored), the substring test fails, the
  code takes the `else` branch, and a genuinely stale credential is **never
  cleared** — the user is left in a loop where the bad stored credential is
  retried every connect with no re-prompt.
- The inverse mis-fire is worse: any non-auth error whose text happens to
  contain "auth failed" (e.g. a wrapped message mentioning "ssh-agent auth
  failed" for a transport problem) will **delete a valid credential** the user
  must then re-enter.
- Credential handling is exactly the kind of destructive, hard-to-diagnose
  behavior the release bar treats as safety-critical. Correctness must not
  depend on the human language of a third-party error string.

## Evidence
- `src/hooks/useConnectSavedConnection.ts:166-172` — the discard gate above.
- `src/utils/classifyAgentError.ts:35` — the same `"auth failed"` /
  `"Authentication failed"` English test is duplicated in the agent-error
  classifier, so the fragility is systemic, not a one-off.
- The produced strings are English constants today (`core`/`agent` error
  formatting), so the gate happens to work in the English build — but it is one
  localized/remote message or one refactor away from silently discarding
  credentials or looping on a stale one.

## Recommendation
Do not classify auth failures by matching human-readable text. Propagate a
**structured, machine-stable error kind** from the backend to the frontend:

1. Give SSH/agent connect errors a typed discriminant (an enum / error `code`
   field on the IPC error payload — e.g. `kind: "auth-failure"`), set at the
   point the failure is known, independent of display text.
2. Gate `removeCredential` on that code, never on the message body.
3. Keep the human message purely for display (and later translation).

Until the structured kind exists, at minimum make the destructive branch
**fail safe**: on an ambiguous/unmatched error, do NOT delete the credential —
prefer re-prompting without discarding, so a locale mismatch can never destroy a
valid stored secret.
