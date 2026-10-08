# Audit remediation — final summary (2026-09-29)

The 2026-09 full-stack audit raised **668 findings** across 38 angles
(7 critical, 139 high, 316 medium, 184 low, 22 info). Every finding file under
`audit/<angle>/` carries its final `status` in the frontmatter; this page is
the roll-up.

Updated 2026-10-08: SEC-002 moved from deferred to fixed — native plugins now run only
out of process in an OS sandbox (ADR-19, #4189). The same day the ledger was reconciled
against closed trackers (#4269): CI-009, SEC-013, SUP-006 and CI-016 moved to fixed;
SUP-004, WA-CI-012 and WA-CI-014 moved from deferred to won't fix, because the maintainer
closed their trackers by accepting the remaining risk (`docs/supply-chain.md`).

| Status   | Count | Meaning                                                           |
| -------- | ----: | ----------------------------------------------------------------- |
| fixed    |   626 | Landed on `develop`, referenced by PR/issue in the finding file   |
| wontfix  |    23 | Deliberately kept as-is, with a recorded reason                   |
| deferred |     8 | Real, but held back by a maintainer decision or tracked elsewhere |
| partial  |     1 | Half done; the other half waits on a maintainer decision          |
| open     |    10 | Marketing/content work that needs the maintainer's voice          |

All 7 critical and every non-marketing high finding are fixed or carry a
recorded decision below. Nothing that the audit flagged as a correctness or
safety bug is left open.

## Still open — marketing (maintainer-owned)

These need product voice and assets, not code:

- MKT-003 README has no screenshots/GIFs
- MKT-004 No value proposition / "why termiHub"
- MKT-006 No at-a-glance feature matrix
- MKT-007 No end-user "first connection" quickstart
- MKT-008 Feature emphasis inverted (experimental feature over shipped ones)
- MKT-009 Visual identity unfinished (placeholder logo, no social preview)
- MKT-010 Concept/mockup corpus invisible to prospective users
- MKT-011 0.1.0 CHANGELOG reads as internal dev notes
- MKT-013 Tagline undersells product breadth
- MKT-014 Trust signals / unsigned-beta messaging underused

## Partial

- **PKG-003** — Update integrity. The agent half is done: agent updates are
  ed25519-signed and verified (#3331; key set via #3800). The desktop updater
  stays check-only (manual download) until desktop signing lands, per the
  unsigned-beta release decision.

## Deferred — decided, not in v0.1.0

| Finding            | Why                                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| CI-008, PKG-004    | Code signing / notarization: unsigned-beta decision; signing planned before v1.0 (installers are provenance-attested, #3348) |
| I18N-012, I18N-017 | English-only, left-to-right beta (maintainer decision 2026-09-25); the string-matching logic bugs were fixed                 |
| CI-001, TIN-001    | The full integration/E2E lane runs nightly, not per PR (slim PR lane, #3325); per-PR static guards were added                |
| CONC-008           | Per-session RDP/VNC mutex is intentional protocol serialization (#2991)                                                      |
| PERF-011           | Full-viewport repaint is the fix for the #1849 stale-rows bug; already off with the default WebGL renderer                   |

## Won't fix — kept deliberately

| Finding                                                          | Why                                                                                                                                                              |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI-007                                                           | Publish-as-prerelease then verify-assets is the chosen release model (#2650)                                                                                     |
| DUP-008                                                          | Desktop and agent keep two frozen, incompatible on-disk formats; merging them is net-negative                                                                    |
| DUP-014                                                          | The three field names are three distinct, test-guarded contracts (disk, RPC, manifest)                                                                           |
| SUP-004, WA-CI-012                                               | Unmaintained-crate advisories stay ungated; clearable ones were cleared and the rest are accepted risks in `docs/supply-chain.md` (#3054 closed via #4169/#4170) |
| WA-CI-014                                                        | Pre-release RustCrypto/Dalek stack accepted as documented risk, enforced by the pre-release allowlist; bump when upstream ships stable (#3734 closed via #4170)  |
| SUP-003, WA-CI-013                                               | RUSTSEC-2023-0071 (`rsa` Marvin) is not reachable: termiHub has no RSA decryption path; accepted risk in `docs/supply-chain.md`                                  |
| LIBBE-003, LIBBE-005, LIBBE-006, LIBBE-007, LIBFE-006            | Hand-rolled code the audit itself judged correct to keep                                                                                                         |
| PARITY-011, TAURI-013                                            | Architecture observations with no action required                                                                                                                |
| PROD-020                                                         | VNC (RFB) has no standard audio channel; documented                                                                                                              |
| PROD-062                                                         | Fonts are already configurable per app and per connection; themes are colour-only by design                                                                      |
| WA-CI-007, WA-CI-009, WA-CI-010, WA-CI-011, WA-CI-015, WA-CI-021 | CI robustness settings the findings themselves recommended keeping                                                                                               |

## Where the work lives

- Per-finding detail and the fixing PR: `audit/<angle>/NNNN-*.md`.
- Ranked release view: `RELEASE-BLOCKERS.md`; totals by angle: `FINDINGS-INDEX.md`.
- Follow-up work that grew out of the audit is in the GitHub issue backlog
  (label `Ready2Implement`).
