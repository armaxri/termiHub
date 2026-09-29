# Supply-chain & dependency audit — summary

Static audit (no tools run) of the Rust workspace (`Cargo.toml`/`Cargo.lock`, 917
packages), the excluded RDP sidecar (`rdp-sidecar/Cargo.lock`, 556 packages), the
npm tree (`package.json` + `pnpm-lock.yaml`, ~1068 packages), `deny.toml`,
`.cargo/audit.toml`, the vendored forks, and the licensing surface, at a
safety-critical-release bar.

## Overall posture

The guard tooling is, for a project this size, **above average**: `cargo deny`
runs four gates (advisories/yanked, bans, licenses, sources) with a *deliberately
non-blanket* license allowlist and a crates.io-only source gate; `cargo audit`
covers RUSTSEC vulnerabilities; a blocking prod-scoped `pnpm audit` gate guards
the shipped npm tree; the pnpm lockfile is v9 (integrity-bearing, all-registry,
no git/tarball sources) and `onlyBuiltDependencies` restricts install scripts to
`esbuild` alone. There are **no git or path dependencies** in the main workspace
lock, and vendored code is confined to two documented forks.

The weaknesses are concentrated and consistent: **the crypto the product most
depends on is unreleased pre-release code, and the dependency graph that most
needs watching (RDP) is entirely outside the gate.** Several controls are
stopgaps (`is_workaround: true`) awaiting the same upstream fix (#1037: russh on
stable RustCrypto) or a systemic mitigation (#2645: yank-storm).

## Top risks (ranked)

1. **SUP-001 (high) — the RDP sidecar's 556-crate graph escapes every
   supply-chain gate.** Workspace-excluded with its own `Cargo.lock`, it is never
   passed to `cargo audit`/`cargo deny`. It contains pre-release CredSSP crypto
   and a frozen vendored fork, decodes untrusted RDP input, and ships in the
   default feature set. A whole second dependency graph with zero yank/advisory/
   license/source coverage.
2. **SUP-002 (high) — SSH/auth crypto is entirely pre-release RustCrypto.** ~18
   `-rc`/`-pre` crates (`rsa 0.10.0-rc.18`, `ssh-key 0.7.0-rc.10`, curve/aead/
   argon2/aes-gcm/p256… all rc) on the primary untrusted-input path. The
   `deny.toml` sign-off names only 2 of the ~18, understating what is accepted.
3. **SUP-009 (medium) — code-delivery trust is checksum-not-signature, and
   plugin signing rests on a `-pre` crate.** The agent self-updater verifies a
   SHA-256 sidecar from the same release (origin authenticity unproven, only
   transit integrity); plugin package signing — the gate before loading arbitrary
   native `.so`/`.dylib` — uses `ed25519-dalek 3.0.0-pre.7`. Both end in code
   execution.
4. **SUP-007 (medium) — X-server (GPL/APSL) licensing is not release-cleared and
   the docs contradict the code.** `docs/licensing.md` requires an unchecked
   counsel sign-off ("not-yet-cleared for release") and still describes VcXsrv
   *redistribution*/`.zip` hosting that the now-winget-only code no longer does —
   the document disagrees with itself and with `THIRD_PARTY_LICENSES.md`. The one
   finding with a distribution-licensing angle.
5. **SUP-006 (medium) — the yanked-crate gate reds all PRs on any upstream yank;
   the fix is a recurring manual stopgap.** Recurred 3× in one session; mitigated
   by a weekly chore + runbook rather than the structural split the runbook itself
   recommends (#2645 open).

## Full finding index

| Id | Sev | Workaround | Title |
| --- | --- | --- | --- |
| SUP-001 | high | yes | RDP sidecar graph excluded from all supply-chain gates |
| SUP-002 | high | yes | SSH/auth crypto path entirely on pre-release RustCrypto |
| SUP-003 | medium | yes | RUSTSEC-2023-0071 (`rsa` Marvin) suppressed in both tools |
| SUP-004 | medium | yes | Unmaintained advisories not gated (`unmaintained = "none"`) |
| SUP-005 | medium | no | Frozen vendored forks (vnc-rs, ironrdp-rdpsnd), no update path |
| SUP-006 | medium | yes | Yank-storm gate reds all PRs; mitigation is a stopgap |
| SUP-007 | medium | no | X-server licensing sign-off pending + stale/contradictory docs |
| SUP-008 | low | yes | ~20 manual npm override pins; dev-dep audit advisory-only |
| SUP-009 | medium | no | Agent update checksum-not-signature; plugin signing on `-pre` crate |
| SUP-010 | low | no | Broad duplicate-version surface (windows-sys ×5, RNG/crypto ×3) |
| SUP-011 | low | no | No declared MSRV; build/test/audit lanes float on `@stable` |
| SUP-012 | low | no | Untrusted-input parsers are predominantly pre-1.0 crates |

## Licensing posture (distribution)

No copyleft blocker in the *linked* dependency graph: the `deny.toml` allowlist is
permissive-only (MIT/Apache/BSD/ISC/Zlib/BSL/Unicode-3.0 + file-level MPL-2.0),
LGPL/GPL/AGPL are intentionally excluded, and the gate would fail a GPL-only
crate. The only GPL/APSL exposure is the **separately-invoked** X servers (VcXsrv,
XQuartz), now provisioned via winget/Homebrew rather than redistributed — so the
distribution obligation is reduced to attribution. The remaining licensing risk is
**process/paperwork, not graph**: the counsel sign-off is unchecked and the
rationale doc is internally stale (SUP-007). The workspace's own crates are
correctly marked `publish = false` and skipped via `private.ignore`.

## Notable positives (not findings)

- crates.io-only source gate; no git/path deps in the main lock; pnpm-lock v9 with
  integrity and no non-registry resolutions.
- `onlyBuiltDependencies: ["esbuild"]` — postinstall scripts restricted.
- Credential-store crypto is on **stable** `aes-gcm 0.10`/`argon2 0.5`, kept
  separate from the SSH RC stack — secrets-at-rest are not on pre-release crypto.
- The FTP client migration (suppaftp 6→11) proactively cleared two advisories
  (async-std RUSTSEC-2025-0052, CRLF-injection RUSTSEC-2026-0271) — evidence the
  team acts on this class when it surfaces.
- `deny.toml`, the yank runbook, and the workflow comments are unusually
  well-reasoned; most findings here are about closing gaps the project already
  half-documents, not about missing awareness.
