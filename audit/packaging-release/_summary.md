# Packaging & Release Engineering — audit summary

Scope: `tauri.conf.json` (+ variants), `src-tauri/Cargo.toml` features/bundle,
sidecar bundling, capabilities, the release/build/dev-build/smoke workflows, the
`build*/release-check/package-plugin/setup-agent-cross` scripts, the custom
desktop+agent update mechanism, and `docs/release-plan-0.1.0.md`. Read-only.

Bottom line: the release pipeline is **structurally close** to the maintainer's
"push one tag → turnkey unsigned beta" goal — it builds all 3 OS + arm64, re-signs
macOS ad-hoc, publishes checksummed agent binaries, and hard-verifies the asset set.
But it is **not ready to ship a clean v0.1.0 without workarounds**: the release build
compiles in dev/test scaffolding (test-bridge, mock backend), update integrity is a
same-channel checksum rather than a signature, two of three platforms have no
install-smoke, and version/tag drift is not gated in the automated path.

## Per-platform readiness scorecard

| Platform | Builds | Signing | Install-smoke | Notable gaps |
| --- | --- | --- | --- | --- |
| macOS arm64 (.dmg) | Yes | Ad-hoc only (Gatekeeper prompt) | **None** | re-sign errors swallowed (PKG-005) |
| macOS x64 (.dmg) | Cross-built on arm64 runner, **never executed** | Ad-hoc only | **None** | wholly unverified artifact (PKG-006) |
| Windows x64 (.msi) | Yes | **Unsigned** (SmartScreen) | **None** | no launch/install check (PKG-006) |
| Linux x64 (.AppImage/.deb) | Yes | Unsigned | **Yes** (release-linux-smoke) | — |
| Linux arm64 (.deb/.rpm) | Yes (native runner) | Unsigned | **Yes** (arm64 smoke) | no AppImage (PKG-011) |

Agent binaries (linux x64/arm64/armv7, macOS x64/arm64, windows x64) are built and
published as separate release assets with `.sha256` sidecars; they are downloaded
on-demand by the desktop deploy path, not bundled.

## Release-pipeline state

- **Trigger:** `v*.*.*` tag → create prerelease → build/upload 5 desktop matrix legs +
  6 agent legs → `verify-release` (asset-name + non-empty-notes gate, folds #480) →
  force-push `latest` tag → notify placeholder.
- **What's automated well:** the asset-set verification gate, per-target RDP sidecar
  cross-build + `externalBin` bundling, agent checksum sidecars, the macOS unsigned
  bypass note appended to every release body, security-release marker emission.
- **What's manual / missing from the automated path:** version⇄tag consistency
  (release-check.sh is manual-only, PKG-007); macOS/Windows install-smoke (PKG-006);
  a robust first-release changelog path (PKG-008); signing on all platforms (PKG-004).

## Signing & update posture

- **Signing:** unsigned public beta on all 3 platforms by explicit maintainer decision
  (deferred to pre-v1.0). macOS is ad-hoc re-signed only; Windows/Linux unsigned. Users
  hit Gatekeeper/SmartScreen warnings; the macOS one-step bypass is documented in every
  release body. Tracked (PKG-004) — but the deferral must remain a single explicit
  pre-v1.0 blocker, and the re-sign step currently swallows failures (PKG-005).
- **Updates:** desktop update is **check-only** (notify + link, no in-app apply —
  PKG-012). Agent self-update (off by default) downloads + installs, verifying a
  `.sha256` fetched from the **same GitHub release** — integrity, not authenticity. No
  signature anywhere in the update path (PKG-003). This is the release-engineering half
  of the security-angle AGT/SEC unsigned-update finding.

## Top blockers to a clean v0.1.0

1. **PKG-003 (high)** — updates verified by same-channel checksum, not a signature; a
   compromised release can serve a trojaned agent binary that passes the check.
2. **PKG-001 (high)** — the full test-bridge (CSP relaxation, JS injection, diagnostic
   routes) is compiled into the release binary, gated only by an env var; not compiled
   out. `is_workaround`.
3. **PKG-006 (high)** — no macOS or Windows install/launch smoke; the Intel macOS DMG
   is cross-built and never executed before publish.
4. **PKG-002 (medium)** — the mock remote-desktop test backend is a default feature and
   ships registered + user-reachable (via experimental features) in release.
   `is_workaround`.
5. **PKG-007 (medium)** — version/tag drift is not gated in the release workflow;
   artifacts can be named with a tag version that disagrees with the bundled app
   version, which also breaks update detection.

## Findings index

| id | sev | wk | title |
| --- | --- | --- | --- |
| PKG-001 | high | yes | Test-bridge (CSP relax + JS injection + diag routes) compiled into release, env-var gated |
| PKG-002 | medium | yes | Mock remote-desktop test backend ships in default release build |
| PKG-003 | high | no | Auto-update integrity is a same-channel checksum, not a signature |
| PKG-004 | medium | yes | Unsigned/un-notarized on all 3 platforms (accepted beta stopgap) |
| PKG-005 | medium | yes | macOS re-sign swallows codesign failures on inner binaries |
| PKG-006 | high | no | No macOS/Windows install-smoke; Intel DMG cross-built and unverified |
| PKG-007 | medium | no | Version/tag drift not gated in release.yml (release-check.sh manual-only) |
| PKG-008 | medium | no | First-release changelog commit-fallback breaks (no prior tag) |
| PKG-009 | low | no | THIRD_PARTY_LICENSES hand-maintained, X-server-scoped, not bundled |
| PKG-010 | low | no | No [profile.release] — unstripped binaries, no LTO |
| PKG-011 | low | yes | Linux ARM64 ships no AppImage (deb/rpm only) |
| PKG-012 | info | no | Desktop "auto-update" is check-only (manual download) |
| PKG-013 | medium | yes | RDP sidecar (excluded crate, own lockfile) bundled but outside audit/lint gates |
| PKG-014 | low | no | Moving `latest` tag force-pushed for prereleases; notify job is a placeholder |
