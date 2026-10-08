---
id: SEC2-005
title: "Plugin bridge open_connection reaches loopback and link-local/metadata addresses without restriction"
angle: security
severity: low
category: security
is_workaround: false
subsystem: "core/src/plugin/capabilities.rs (guarded_connect)"
evidence:
  - core/src/plugin/capabilities.rs:181
  - core/src/plugin/capabilities.rs:232
  - core/src/plugin/capabilities.rs:248
  - src/components/Settings/nativePluginSandbox.ts:189
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

`guarded_connect` checks only the `network` permission and the connection slot, then calls `(host, port).to_socket_addrs()` and connects to whatever resolves. That includes 127.0.0.1/::1, 169.254.169.254 and other link-local addresses, and RFC1918. The host opens the socket and passes the descriptor to the sandboxed runner, so the plugin gets the host's full network position, including same-user loopback services that rely on 'only local processes can reach me' (an unauthenticated Docker daemon on tcp://127.0.0.1:2375, dev servers, termiHub's own embedded HTTP/FTP servers) and the cloud metadata endpoint when termiHub runs on a cloud VM. The HTTP monitor got an SSRF default-deny for exactly this class (SEC-008); the more-untrusted plugin path did not.

## Why it matters

The UI promises "Outbound TCP only through termiHub". Users reasonably read 'outbound' as remote hosts. Loopback access lets sandboxed code drive privileged local daemons, which can be a full escape (Docker API → root).

## Evidence

- `core/src/plugin/capabilities.rs:181`
- `core/src/plugin/capabilities.rs:232`
- `core/src/plugin/capabilities.rs:248`
- `src/components/Settings/nativePluginSandbox.ts:189`

## Recommendation

Reuse the SEC-008 `is_blocked_ip` classifier in `connect_with_timeout`: filter each resolved address, always deny link-local/unspecified/broadcast, and deny loopback and private ranges unless the manifest declares an explicit opt-in (e.g. `connectionPolicy.allowLocalNetwork`) that the trust chips display. Resolve once and connect only to the vetted addresses (no rebinding window).

## Verification

Confirmed. connect_with_timeout (capabilities.rs:181) resolves the host and connects to any address. Nothing in core/src/plugin filters by IP, unlike SEC-008 for the HTTP monitor. There is partial by-design justification: a network-permitted terminal-backend plugin may legitimately target LAN hosts or localhost, and it already reaches the whole internet. I found no documented decision about loopback or metadata access for plugins, though, and the UI chip says 'Outbound TCP only through termiHub'. Low.
