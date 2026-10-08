---
id: SEC2-007
title: "SEC-008 SSRF guard still allows the Alibaba Cloud metadata IP, and AWS IPv6 IMDS under the private-network opt-in"
angle: security
severity: low
category: security
is_workaround: false
subsystem: "core/src/monitoring/http_monitor.rs"
evidence:
  - core/src/monitoring/http_monitor.rs:655
  - core/src/monitoring/http_monitor.rs:673
  - core/src/monitoring/http_monitor.rs:676
  - core/src/monitoring/http_monitor.rs:687
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: previous-incomplete
previous_id: SEC-008
---

## What

The fix claims that cloud metadata endpoints are always blocked (link-local + unspecified + broadcast). `100.100.100.200` (Alibaba Cloud ECS metadata) is in 100.64/10 CGNAT space. It is neither `is_private()` nor link-local, so it is reachable even without `allowPrivateNetwork`. `fd00:ec2::254` (AWS IMDS over IPv6) is classed as unique-local, so it becomes reachable as soon as a user opts into `allowPrivateNetwork` for an ordinary LAN target, even though the comment promises metadata stays blocked.

## Why it matters

The agent-side monitor runs on remote hosts that are often cloud VMs. The guard's stated invariant (metadata never reachable) does not hold on Alibaba Cloud, or on AWS IPv6 with the opt-in on.

## Evidence

- `core/src/monitoring/http_monitor.rs:655`
- `core/src/monitoring/http_monitor.rs:673`
- `core/src/monitoring/http_monitor.rs:676`
- `core/src/monitoring/http_monitor.rs:687`

## Recommendation

Add an always-blocked list of explicit metadata addresses that applies regardless of allow_private: 100.100.100.200, fd00:ec2::254, and 169.254.0.0/16 (already covered). Consider also blocking 100.64.0.0/10 unless allow_private, and NAT64 forms (64:ff9b::/96 mapped onto blocked v4). Add regression tests for each.

## Verification

Confirmed. is_blocked_ipv4 (http_monitor.rs:673) always blocks only unspecified, link-local and broadcast addresses, plus loopback and RFC1918 when allow_private is false. 100.100.100.200 is in 100.64/10, which is not covered by is_private, so the Alibaba metadata IP is reachable. fd00:ec2::254 is fc00::/7, which allowPrivateNetwork unblocks. The doc comment implies metadata is always blocked, but it only lists 169.254.169.254. Low.
