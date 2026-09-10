---
id: PER-007
title: Stored passwords are shell/env-expanded, silently corrupting secrets containing $ or ~
angle: persistence-migration
severity: medium
category: bug
is_workaround: false
subsystem: core/src/config, src-tauri/src/terminal/backend
evidence:
  - core/src/config/mod.rs:65
  - core/src/config/mod.rs:312
  - core/src/config/mod.rs:625
  - core/src/config/mod.rs:637
  - src-tauri/src/terminal/backend.rs:211
status: open
---

## What

`expand_config_value` runs full shell-style expansion (`shellexpand::full_with_context`, resolving
`~`, `$VAR`, and `${VAR}`) over config string values, and it is applied **to the `password`
field** on every connection type that has one:

```rust
// core/src/config/mod.rs:65-75
pub fn expand_config_value(value: &str) -> String {
    ...
    shellexpand::full_with_context(value, home_dir, lookup)  // resolves ~, $VAR, ${VAR}
        .expect(...).into_owned()
}
```

Applied to secrets at `core/src/config/mod.rs:312` (SSH), `:625` and `:637` (other backends), and
`src-tauri/src/terminal/backend.rs:211`:

```rust
self.password = self.password.map(|s| expand_config_value(&s));
```

Any password that legitimately contains `$`, `${...}`, or a leading `~` is **silently rewritten**.
Unknown variables expand to empty string (`std::env::var(name).unwrap_or_default()`), so
`pa$$word` → `paword`-style corruption, `~foo` → a home-dir path, `${TOKEN}` → `""`.

## Why it matters

The password the app actually authenticates with is not the password the user stored — it is a
shell-expanded derivative. For a user whose real credential contains a `$` (common in generated
secrets) this means **auth silently fails** with a password that looks correct in the editor, and
there is no indication the stored secret was transformed. From a persistence-integrity standpoint the
effective value of a persisted secret depends on the process environment at connect time, which is
neither stable nor visible. (Security angle likely also owns the injection surface of expanding
secrets through env vars; this finding is about the data-integrity/corruption facet.)

## Evidence

- `core/src/config/mod.rs:65-75` — `expand_config_value` does full `~`/`$VAR`/`${VAR}` expansion,
  unknown vars → empty string.
- `core/src/config/mod.rs:312`, `:625`, `:637` and `terminal/backend.rs:211` — the same expansion is
  mapped over `self.password`.

## Recommendation

Do **not** env-expand secret fields. Expansion is appropriate for path-like fields (`key_path`,
`starting_directory`, `working_directory`) and arguably host/username, but a password/passphrase must
be used verbatim. Exclude `password`/passphrase fields from `expand_config_value`, or gate expansion
behind an explicit opt-in per field. Add a regression test that a password containing `$`, `${x}`,
and a leading `~` round-trips unchanged to the backend.
</content>
