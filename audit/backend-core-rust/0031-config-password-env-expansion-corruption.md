---
id: CORE-031
title: Config expansion runs env/tilde expansion over passwords — secret corruption and env-var leakage
angle: backend-core-rust
severity: medium
category: bug
is_workaround: false
subsystem: core/config
evidence:
  - core/src/config/mod.rs:637
  - core/src/config/mod.rs:625
status: fixed
resolution: "#2729"
---

## What
`SshConfig::expand` (and `FtpConfig::expand`) run the generic
`${VAR}`/`~` expander over the password field:

```rust
self.password = self.password.map(|s| expand_config_value(&s));
```

## Why it matters
Passwords are opaque secrets, not templates. Expanding them means:
1. **Corruption:** a legitimate password containing `${`, `~`, or `$` is silently
   rewritten (e.g. `p$${w0rd}` becomes something else), so authentication fails
   with no obvious cause.
2. **Leakage / injection:** `${HOME}` or `${PATH}` embedded in a password expands
   to environment values, turning a password field into an env-var exfiltration
   or unexpected-substitution vector.

Host/username/path expansion is reasonable; password expansion is not.

## Evidence
`core/src/config/mod.rs:631-641` (SSH) and `:620-628` (FTP) apply
`expand_config_value` to `password`.

## Recommendation
Do not expand secret fields. Leave `password` verbatim (and audit any other
credential/secret field) while keeping expansion for host, username, key path,
and directories.
