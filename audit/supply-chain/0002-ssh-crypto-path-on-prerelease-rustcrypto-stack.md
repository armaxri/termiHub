---
id: SUP-002
title: The SSH/auth crypto path is built entirely on pre-release (-rc/-pre) RustCrypto crates
angle: supply-chain
severity: high
category: supply-chain
is_workaround: true
subsystem: core/backends/ssh
evidence:
  - Cargo.lock:5850
  - Cargo.lock:6959
  - Cargo.lock:1454
  - deny.toml:101
  - core/Cargo.toml:51
status: open
---

## What

Every crate in the SSH authentication and key-handling crypto path resolves to
an **unreleased pre-release** version. The main-app `Cargo.lock` pins, among
others:

| Crate | Locked version |
| --- | --- |
| `rsa` | 0.10.0-rc.18 |
| `ssh-key` | 0.7.0-rc.10 |
| `ssh-cipher` / `ssh-encoding` | 0.3.0-rc.9 |
| `ecdsa` | 0.17.0-rc.18 |
| `elliptic-curve` | 0.14.0-rc.32 |
| `p256` / `p384` / `p521` | 0.14.0-rc.9 (also pinned `=0.14.0-rc.9` in `core/Cargo.toml`) |
| `pkcs1` | 0.8.0-rc.4 |
| `aead` | 0.6.0-rc.10 |
| `aes-gcm` | 0.11.0-rc.4 |
| `argon2` | 0.6.0-rc.8 |
| `blake2` | 0.11.0-rc.6 |
| `curve25519-dalek` | 5.0.0-pre.6 |
| `ed25519-dalek` | 3.0.0-pre.7 |
| `primefield` / `primeorder` | 0.14.0-rc.9 / -rc.1 |

These are pulled transitively through `russh 0.61` (the SSH client that is the
project's **primary** remote-access backend) and `russh-sftp`. The SSH path
processes untrusted remote input during the handshake, so its crypto is on the
hot security path.

## Why it matters

Pre-release crates carry no stability or security-maintenance promise: the
`-rc`/`-pre` API and, more importantly, the underlying implementations can change
under the project between rc bumps, and a soundness fix may only ever land in the
*next* rc (which a pinned `=0.14.0-rc.9` will not receive automatically). For a
release explicitly held to a "ventilator-grade" bar, staking SSH — the flagship
protocol — on unreleased cryptographic primitives is the single largest
supply-chain exposure in the tree.

The `deny.toml` `[bans]` block does document this as an accepted release
sign-off, but it names only **`rsa 0.10.0-rc.x` and `ssh-key 0.7.0-rc.x`**. The
actual pre-release surface is ~18 crates spanning the whole RustCrypto stack
(AEAD, hashing, elliptic curves, key encoding). The sign-off understates what is
actually being accepted, so a reviewer reading `deny.toml` does not see the true
breadth.

## Evidence

- `Cargo.lock` — `rsa` (5850), `ssh-key` (6959), `curve25519-dalek` (1454),
  `p256/p384/p521`, `ecdsa`, `elliptic-curve`, `aes-gcm`, `argon2`, `blake2`,
  etc. all at `-rc`/`-pre` versions (enumerated via
  `grep -E 'version = "[0-9]+\.[0-9]+\.[0-9]+-(rc|pre)'`).
- `core/Cargo.toml:51-53` — `p256/p384/p521 = "=0.14.0-rc.9"` hard-pinned.
- `deny.toml:101-116` — `[bans]` sign-off mentions only `rsa` + `ssh-key`.
- Note (positive): the **credential store** crypto is on *stable* releases
  (`aes-gcm 0.10.3`, `argon2 0.5.3` — `src-tauri/Cargo.toml:107-108`), a separate
  duplicated copy from the SSH RC stack. Secret-at-rest encryption is therefore
  not on pre-release crypto; only the SSH transport is.

## Recommendation

The real fix is upstream: move to a `russh` release cut against the **stable**
RustCrypto 0.7/0.10 line (tracked in #1037) and drop the `=0.14.0-rc.9` pins.
Until then, at minimum: (1) expand the `deny.toml` `[bans]` note to enumerate the
full RC set actually being accepted, so the sign-off is honest; (2) add a
`bans.deny`/wildcard tripwire that fails CI if the RC *lines* drift to a version
other than the reviewed ones (the yanked gate only catches withdrawals, not a
silent rc-bump to unreviewed code); (3) record an explicit maintainer decision in
the release PR that ships SSH on pre-release crypto is acceptable for this
release, given it is safety-critical.
