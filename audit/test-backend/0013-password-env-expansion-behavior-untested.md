---
id: TBE-013
title: Password fields are run through ${VAR}/~ shell expansion with no test pinning the behavior
angle: test-backend
severity: medium
category: test-gap
is_workaround: false
subsystem: core/config
evidence:
  - core/src/config/mod.rs:312
  - core/src/config/mod.rs:625
  - core/src/config/mod.rs:637
  - core/src/config/mod.rs:865
status: open
---

## What
`Config::expand()` runs the `password` field through `expand_config_value` for SSH, FTP, and other
backends (mod.rs:312, :625, :637). `expand_config_value` performs `${VAR}`/`$VAR` and leading-`~`
expansion via `shellexpand`, and — per its own test `expand_value_unknown_variable_becomes_empty`
(mod.rs:865) — an **unknown variable expands to an empty string**. Despite ~30 expansion tests in
this module, **none asserts anything about the password field specifically**: not that a literal
password containing `$` survives, not that `${TYPO}` in a password becomes empty (silent credential
loss), not that expansion of a secret is even desired.

## Why it matters
Two concrete, untested failure modes on a credential path:
1. A legitimate password containing `$`, `${`, or a leading `~` (all valid password characters) is
   silently corrupted before authentication — the user gets an unexplained auth failure.
2. A password written as `${SECRET}` that references an unset/mistyped var expands to `""`, so the
   client attempts to authenticate with an **empty password** — a security-relevant silent
   downgrade. A cross-expert finding flags password env-expansion as a defect; the test suite has
   no assertion that would catch either behavior or a regression in it.

## Evidence
- mod.rs:308-312, 621-637 — `self.password = self.password.map(|s| expand_config_value(&s));`
- mod.rs:865-870 — `expand_value_unknown_variable_becomes_empty` proves unknown → `""`, but only
  for a generic value, never routed through a password field.
- Test list for config/mod.rs shows host/port/key-path/volume/jump-host expansion tests — no
  `password` case.

## Recommendation
Decide and pin the intended behavior with tests: if secrets should NOT be shell-expanded (the safe
default for arbitrary passwords), stop calling `expand_config_value` on `password` and add a
regression test that a `$`/`~`-containing password passes through verbatim. If expansion is
intended, add tests that (a) a literal-`$` password is handled per policy and (b) an unknown-var
password does **not** silently become an empty auth attempt (fail closed instead).
