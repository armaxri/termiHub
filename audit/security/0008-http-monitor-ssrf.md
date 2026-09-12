---
id: SEC-008
title: HTTP monitor fetches arbitrary user URLs with no SSRF protection (metadata endpoint reachable)
angle: security
severity: high
category: security
is_workaround: false
subsystem: core/src/monitoring
evidence:
  - core/src/monitoring/http_monitor.rs:585
  - core/src/monitoring/http_monitor.rs:521
status: fixed
resolution: "#2728 — SSRF default-deny + allowPrivateNetwork opt-in"
---

## What

The HTTP monitor network tool fetches a free-text user-supplied URL with no
restriction on the destination:

```rust
// core/src/monitoring/http_monitor.rs:585
match client.request(method, &config.url).send().await {
```

`config.url` is a plain form field. The client is built (`http_monitor.rs:521-523`)
with only a timeout — no blocklist for loopback/`127.0.0.0/8`, link-local
`169.254.0.0/16` (including the cloud-metadata endpoint `169.254.169.254`),
private RFC 1918 ranges, or `::1`, and no redirect-policy restriction (a public URL
can 302 to an internal one). Critically, the HTTP monitor can also run
**agent-side**, so the fetch originates from the agent host and can reach that
host's internal network and metadata service.

## Why it matters

This is a classic SSRF primitive. On a cloud-hosted agent, pointing a monitor at
`http://169.254.169.254/latest/meta-data/iam/security-credentials/…` returns IAM
credentials; on any deployment it can probe and interact with internal-only
services (admin panels, databases with HTTP interfaces, other agents, the agent's
own unauthenticated `--listen` port from SEC-004) that are not otherwise reachable
from the operator's network. Response status/latency (and any error text) are
surfaced back to the user, giving a read/oracle channel. For a device that may sit
on a hospital network, an SSRF that pivots to internal infrastructure is a real
exposure.

## Evidence

- `core/src/monitoring/http_monitor.rs:585` — unrestricted `client.request(method, &config.url)`.
- `core/src/monitoring/http_monitor.rs:521-523` — client builder sets only a
  timeout; no IP/host filtering, no `redirect::Policy` restriction.
- `config.url` is a user form field (schema field ~`:190`); the monitor runs both
  desktop- and agent-side.

## Recommendation

Add SSRF defenses to the monitor fetch: resolve the host and reject targets in
loopback, link-local (esp. `169.254.169.254`), unique-local, and — behind an
opt-in — RFC 1918 private ranges; re-validate after each redirect (or set
`redirect::Policy::none()` and validate every hop); and consider a
default-deny-with-allowlist posture for the agent-side monitor. A maintained
helper (validate against `ipnetwork`/`ip_network` blocklists, or a vetted
SSRF-guard crate) is preferable to hand-rolled checks. Document that the monitor
must not be usable to reach the agent's own loopback services. Make sure the
resolved-then-connected IP is the one checked (avoid DNS-rebinding TOCTOU) — pin
the resolved address for the actual connection.
