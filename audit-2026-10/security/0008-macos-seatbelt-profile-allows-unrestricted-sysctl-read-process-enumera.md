---
id: SEC2-008
title: "macOS Seatbelt profile allows unrestricted sysctl-read (process enumeration / possibly other processes' argv)"
angle: security
severity: info
category: security
is_workaround: false
subsystem: "plugin-runner/src/sandbox/macos.rs"
evidence:
  - plugin-runner/src/sandbox/macos.rs:53
  - plugin-runner/src/sandbox/macos.rs:54
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

PROFILE_HEAD grants `(allow sysctl-read)` with no `sysctl-name` filter, while process-info is correctly limited to `(target self)`. Unfiltered sysctl-read exposes kern.proc.\* (the full process list with pids, uids and command names), and depending on the macOS version and kernel checks, kern.procargs2 for same-uid processes (argv plus environment). Chromium and Firefox renderer profiles allow-list a small set of sysctl names for this reason. Whether KERN_PROCARGS2 of other same-uid processes is actually readable under this profile was not verified on a device at this commit.

## Why it matters

If readable, environment variables of the user's other processes (tokens exported in shells, agent sockets) would leak into the plugin. Even the process list is reconnaissance the plugin has no need for.

## Evidence

- `plugin-runner/src/sandbox/macos.rs:53`
- `plugin-runner/src/sandbox/macos.rs:54`

## Recommendation

Replace `(allow sysctl-read)` with `(allow sysctl-read (sysctl-name "hw.ncpu" "hw.activecpu" "hw.memsize" "hw.pagesize" "kern.osversion" "kern.osrelease" …))`, i.e. the names the Rust/C runtime actually queries, determined by running the runner under `sandbox-exec` with logging. Add a sandbox test that asserts `sysctl(KERN_PROC_ALL)` and `KERN_PROCARGS2` for the parent pid fail.

## Verification

Confirmed. macos.rs PROFILE_HEAD contains an unfiltered '(allow sysctl-read)', while process-info\* is limited to (target self). The process list via kern.proc is exposed. Whether KERN_PROCARGS2 is readable for other processes is unverified, as the finding itself admits, so info is right.
