---
id: OBS2-005
title: "README tells users to attach the unredacted termihub.log instead of the redacted Export Diagnostics bundle"
angle: observability
severity: low
category: privacy-diagnostics
is_workaround: false
subsystem: "README.md Logs and Troubleshooting"
evidence:
  - README.md:420
  - README.md:430
  - README.md:89
  - src-tauri/src/commands/agent.rs:172
  - core/src/backends/telnet/mod.rs:501
  - src-tauri/src/utils/diagnostics_bundle.rs:86
status: fixed
resolution: "#4317 — README troubleshooting now recommends the redacted Export Diagnostics bundle and warns the raw log is unredacted"
audit: 2026-10
commit: "663465d52"
relation: new
---

## What

The troubleshooting section says the raw termihub.log 'is the one to attach when reporting a problem' (README.md:420) and never mentions Export Diagnostics. termihub.log is not redacted. It records hostnames at INFO (for example commands/agent.rs:172 `host = %config.host` and telnet/mod.rs:501), plus usernames and home paths in error text, and the forwarded frontend error messages. The Export Diagnostics bundle exists precisely to mask 'host names, IP addresses, usernames and home directory paths' (diagnostics_bundle.rs README text) and also carries crash reports and system info. It is mentioned only in the privacy paragraph at README.md:89.

## Why it matters

Users follow the documented path and post an unredacted file, often into a public GitHub issue. That leaks infrastructure hostnames and IPs, and they miss the crash reports and build info that the bundle includes.

## Recommendation

Rewrite README.md:418-430 to recommend Settings menu → Export Diagnostics… as the thing to attach, and to explain that it is redacted and includes crash reports and system info. Keep the raw file paths for advanced use, with a warning that the raw file contains hostnames and paths and is not redacted.

## Verification

Confirmed. README's persistent-log section says termihub.log 'is the one to attach when reporting a problem' and never mentions Export Diagnostics there; the bundle is mentioned only in the privacy note at :89. The log records `host = %config.host` at INFO (commands/agent.rs:172). The README says passwords and terminal contents are excluded, but says nothing about hostnames.
