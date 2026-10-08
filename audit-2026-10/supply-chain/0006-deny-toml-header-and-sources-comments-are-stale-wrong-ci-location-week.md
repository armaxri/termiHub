---
id: SUP2-006
title: "deny.toml header and sources comments are stale (wrong CI location, weekly cadence, every-PR yank claim, only vnc-rs listed as a path fork)"
angle: supply-chain
severity: low
category: docs
is_workaround: false
subsystem: "workspace / deny.toml"
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
evidence:
  - deny.toml:5
  - deny.toml:17
  - deny.toml:18
  - deny.toml:104
  - deny.toml:105
  - Cargo.toml:117
  - Cargo.toml:118
---

## What

deny.toml says CI runs it in `.github/workflows/code-quality.yml -> "Security Audit"`, but it has run in security-audit.yml since #3325. It says a yanked transitive crate 'reds every open PR here at once' and is mitigated by the 'weekly' cargo update chore. Since #3326 PRs run the audit only when a manifest changes, and since #3291 the chore runs daily. The [sources] comment names only `vnc-rs` as an in-tree path crate outside the source check. The workspace now also [patch]es serial2 and libunftp from vendor/ (Cargo.toml:117-118), and those crates are likewise invisible to the sources/advisory gates.

## Why it matters

deny.toml is the first file a maintainer reads when the gate fires. Stale pointers send them to the wrong workflow and misstate which forks bypass cargo-deny, the very blind spot the vendored-fork register exists to cover.

## Recommendation

Update the header to point at security-audit.yml (and rdp-sidecar/deny.toml for the sidecar), say 'daily', and describe the post-merge/daily lane. In [sources], list every path or [patch] fork (vnc-rs, serial2, libunftp) and point to vendor/vendored-forks.json as their monitoring path.

## Verification

Confirmed stale. deny.toml:5 points to code-quality.yml -> Security Audit, but the check now lives in security-audit.yml. Line 18 says 'weekly', but the chore cron is daily (0 4 \* \* \*). Line 17's claim that a yanked crate reds every open PR is outdated now that the PR lane is path-filtered. The [sources] comment names only vnc-rs, although Cargo.toml [patch.crates-io] also patches serial2 and libunftp from vendor/. This is documentation drift only, so low (info would also be defensible).
