---
id: PARITY-010
title: Authentication is modelled ad-hoc per backend; no client-cert / 2FA anywhere
angle: connection-parity
severity: medium
category: arch
is_workaround: false
subsystem: core/src/backends
evidence:
  - core/src/backends/ssh/mod.rs:303
  - core/src/backends/ftp/mod.rs:365
  - core/src/connection/graphical.rs:316
status: open
---

## What

Every backend that authenticates does so with its own, unrelated representation:

- **SSH:** a free-form `authMethod` **string** field with select options `key` / `password` /
  `agent`, validated only by the schema's select-option list.
- **FTP:** an `anonymous` **boolean** toggle that conditionally shows `username`/`password`.
- **Graphical (VNC/RDP):** a typed `AuthKind` enum (`None`, `Password`, `UsernamePassword`, `Nla`)
  advertised via `GraphicalCapabilities.auth_kinds`, negotiated at the protocol layer.
- **Docker / telnet / serial / local:** no authentication concept.

There is no shared notion of "authentication method" across the terminal and graphical families,
and **no backend supports client certificates or 2FA / keyboard-interactive** (SSH offers only
key/password/agent; no `keyboard-interactive`, no certificate auth; FTP has no client-cert auth
even under FTPS).

## Why it matters

- The typed `AuthKind` enum on the graphical side is the good model — it lets the frontend reason
  about auth (e.g. warn on insecure schemes). The terminal side throws that away and uses an
  untyped string (`authMethod`) whose valid values live only in a schema select list, so the two
  families cannot share auth UI or validation.
- The absence of SSH `keyboard-interactive` / 2FA is a real functional gap for a terminal hub
  (many bastions require it), and it is inconsistent that graphical RDP models NLA while SSH cannot
  model MFA at all.
- Credential-store integration is likewise per-backend (`savePassword` on SSH, `saveToStore` on
  graphical) — see PARITY-006-style naming drift.

## Evidence

- `core/src/backends/ssh/mod.rs:303` — `authMethod` as a `Select` of string options; no
  keyboard-interactive/cert option.
- `core/src/backends/ftp/mod.rs:365` — `anonymous` boolean drives auth.
- `core/src/connection/graphical.rs:316` — typed `AuthKind` enum + `auth_kinds` capability.

## Recommendation

Lift a shared, typed auth-method concept (analogous to `AuthKind`) to the `ConnectionType` layer so
terminal and graphical backends describe auth the same way, and unify the credential-save field
name. Separately, add SSH `keyboard-interactive` (2FA) support — its absence is both a parity gap
against RDP/NLA and a standalone functional gap tracked under product-completeness.
