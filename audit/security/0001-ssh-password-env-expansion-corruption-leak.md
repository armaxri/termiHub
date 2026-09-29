---
id: SEC-001
title: SSH/Docker/serial passwords are run through shell env-expansion, corrupting or leaking secrets
angle: security
severity: high
category: security
is_workaround: false
subsystem: core/src/config
evidence:
  - core/src/config/mod.rs:312
  - core/src/config/mod.rs:626
  - core/src/config/mod.rs:637
  - core/src/config/mod.rs:65
status: fixed
resolution: "#2729"
---

## What

Every connection config's `password` field is passed through `expand_config_value()`
(backed by the `shellexpand` crate) during `SshConfig::expand()` /
`TelnetConfig::expand()` / other `expand()` impls. `expand_config_value` performs
`${VAR}` / `$VAR` environment-variable substitution **and** leading-`~` home
expansion on the secret string.

```rust
// core/src/config/mod.rs:312 (SshConfig::expand)
self.password = self.password.map(|s| expand_config_value(&s));
// also :626 (telnet) and :637 (another backend), same pattern
```

```rust
// core/src/config/mod.rs:65
pub fn expand_config_value(value: &str) -> String {
    ...
    let lookup = |name: &str| -> Result<Option<String>, ...> {
        Ok(Some(std::env::var(name).unwrap_or_default())) // unknown var -> ""
    };
    shellexpand::full_with_context(value, home_dir, lookup) ...
}
```

## Why it matters

A password is opaque secret material and must be transmitted byte-for-byte. Running
it through shell expansion breaks that in two security-relevant ways:

1. **Silent secret corruption.** `$`, `${…}`, and a leading `~` are all valid
   password characters. A password such as `pa$$w0rd`, `S3cret$HOME`, or
   `~mypass` is silently mangled: `$$w0rd`/`${…}` expand (unknown vars → empty
   string, so characters are *deleted*), and a leading `~` becomes the home
   directory. The credential the user stored is not the credential sent on the
   wire — auth fails mysteriously, and on a ventilator-grade device an operator
   locked out of a device mid-incident is a safety event.
2. **Environment-variable exfiltration to the remote.** Because unknown/known
   vars are looked up from the *desktop process* environment, a password value
   containing `${AWS_SECRET_ACCESS_KEY}` (or any env var) is expanded to that
   variable's value and then **sent as the password to the remote SSH/telnet
   server**. Against a malicious or compromised host (in scope for this threat
   model) this turns the password field into an arbitrary local-environment read
   primitive that leaks host secrets off-box. It also means a shared/exported
   connection profile can be crafted to harvest a victim's environment when they
   connect.

`host`/`username` are also expanded (arguably intended for `${VAR}`-templated
profiles), but a **password** should never be templated — the expansion has no
legitimate use there and only introduces corruption and a disclosure channel.

## Evidence

- `core/src/config/mod.rs:312` — `SshConfig::expand` expands `password`.
- `core/src/config/mod.rs:626`, `:637` — telnet / other backend `expand` do the same.
- `core/src/config/mod.rs:65-74` — `expand_config_value` performs env + tilde
  expansion, unknown vars → empty string.
- Contrast: `expand_tilde_only` (`:45`) exists precisely *because* env expansion
  is unsafe for user-supplied strings ("so it is safe for user-supplied paths
  where a literal `$` should not be interpreted") — the password path does not
  use it.

## Recommendation

Do **not** env-expand secret fields. Remove the `password` expansion from every
`expand()` impl (leave `host`/`username`/`key_path` templating if that is a
documented feature, but even there prefer `expand_tilde_only` for values that are
not meant to be templated). Add a regression test asserting that a password
containing `$`, `${HOME}`, and a leading `~` round-trips unchanged through
`expand()`. If per-profile secret templating is ever genuinely wanted, make it an
explicit opt-in with a distinct, clearly-documented syntax rather than implicit
shell expansion of the raw secret.
