---
id: SUP-010
title: Broad duplicate-version surface (crypto RNG, windows-sys, hashbrown) inflates audit + binary surface
angle: supply-chain
severity: low
category: supply-chain
is_workaround: false
subsystem: workspace
evidence:
  - Cargo.lock
  - deny.toml:116
status: open
---

## What

The workspace lockfile carries many crates at multiple concurrent major versions.
Measured from `Cargo.lock`:

| Crate | Versions present |
| --- | --- |
| `windows-sys` | 0.45.0, 0.52.0, 0.59.0, 0.60.2, 0.61.2 (×5) |
| `hashbrown` | 0.12.3, 0.14.5, 0.15.5, 0.17.1 (×4) |
| `rand` / `rand_core` / `getrandom` | ×3 each (0.8/0.9/0.10 lines) |
| `generic-array`, `digest`, `block-buffer`, `base64`, `cbc`, `aes`, `aes-gcm`, `argon2` | ×2 each |

`deny.toml` sets `[bans] multiple-versions = "allow"`, so none of this gates CI.

## Why it matters

Multiple versions of one crate are normal in a large tree and are *not* a
vulnerability on their own — this is correctly low severity. But it has real
supply-chain cost for a safety-critical audit: (1) the same advisory may need to
be assessed against several versions; (2) the RNG/crypto duplication in
particular (`rand`/`rand_core`/`getrandom` ×3, `aes-gcm`/`argon2` split between a
stable and a `-rc` copy) means two independent crypto stacks are compiled in, so
"is our crypto current" must be answered twice; (3) it enlarges the shipped binary
and the number of distinct maintainers the project transitively trusts.

## Evidence

- Counts derived via `grep -A1 '^name = "<crate>"' Cargo.lock | grep '^version'`.
- `deny.toml:101-116` — `multiple-versions = "allow"` (documented as "common in a
  large tree … not a supply-chain signal on their own").

## Recommendation

Keep `multiple-versions = "allow"` (failing on it would be noise), but add a
periodic advisory `cargo tree --duplicates` report to the supply-chain job so the
duplication is *visible* and trending, and so a *newly* introduced second copy of
a security-sensitive crate (a third crypto RNG line, say) is noticed. Where cheap,
unify the RNG/crypto duplication as the SSH stack moves off pre-release RustCrypto
(SUP-002) — that migration should collapse the stable-vs-rc `aes-gcm`/`argon2`
and `rand` splits on its own.
