---
id: UX-010
title: SSH key-passphrase prompt is mislabeled "SSH Password"
angle: ux-flows
severity: medium
category: ux
is_workaround: false
subsystem: src/components/PasswordPrompt
evidence:
  - src/components/PasswordPrompt/PasswordPrompt.tsx:52
  - src/components/PasswordPrompt/PasswordPrompt.tsx:68
  - src/components/ConnectionEditor/ConnectionEditor.tsx:961
status: open
---

## What
When connecting with an encrypted SSH **key** (not password auth), the app requests the key
passphrase via the same generic `requestPassword` flow (credentialType computed as
`key_passphrase`, `ConnectionEditor.tsx:961-963,1003`), but the shared prompt hardcodes
password-auth wording: title "SSH Password" (`PasswordPrompt.tsx:52`), body "Enter password for
{username}@{host}" (`:68-70`), checkbox "Save password" (`:88`).

## Why it matters
For a passphrase-protected key the user is asked for a "password" for a host, which is conceptually
the key's passphrase, not a login password. This is confusing and can lead the user to type the
wrong secret (their account password instead of the key passphrase), producing a puzzling auth
failure.

## Evidence
- `PasswordPrompt.tsx:52,68-70,88` — hardcoded "SSH Password" / "Enter password for …" / "Save
  password".
- `ConnectionEditor.tsx:961-963,1003` — passphrase requested through the same prompt with
  `credentialType = key_passphrase`.

## Recommendation
Parameterize the prompt copy by credential type: when the credential is a `key_passphrase`, show
"Key Passphrase", "Enter passphrase for key {keyPath}", and "Remember passphrase". The prompt
already receives enough context to branch.
