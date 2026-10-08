---
id: PLG2-004
title: "Sandboxed plugins cannot reach the OS certificate trust store (Linux landlock allow-list has no /etc/ssl; macOS deny-default blocks trustd), so TLS backends cannot use system or corporate CAs, and this is undocumented"
angle: plugin-extensibility
severity: medium
category: missing-feature
is_workaround: false
subsystem: "plugin-runner/src/sandbox (linux.rs, macos.rs) + plugin-authoring sandbox docs"
evidence:
  - plugin-runner/src/sandbox/linux.rs:69
  - plugin-runner/src/sandbox/linux.rs:80
  - plugin-runner/src/sandbox/macos.rs:25
  - plugin-runner/src/sandbox/macos.rs:45
  - core/src/plugin/sandbox/bridge.rs:440
  - docs/plugin-authoring.md:504
  - docs/plugin-authoring.md:530
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The bridge hands a plugin only a raw connected TCP socket, so any TLS has to happen inside the sandboxed plugin. On Linux, `SYSTEM_READ_DIRS` covers library dirs, ld.so.cache, localtime/zoneinfo and random devices, but not `/etc/ssl`, `/etc/pki`, `/usr/share/ca-certificates` or `/etc/ca-certificates`. rustls-native-certs or OpenSSL default verify paths therefore fail with EACCES. On macOS the profile is `(deny default)` with no `mach-lookup` allowance, so Security.framework trust evaluation, which goes through the trustd/securityd XPC services, fails. The sandbox section of plugin-authoring.md lists what fails (files, sockets, processes, devices) and says nothing about TLS roots.

## Why it matters

The documented example plugin (k8s-exec) and most realistic network backends (cloud consoles, HTTPS/WebSocket APIs, MQTT over TLS) need certificate validation. Authors will see opaque handshake failures only after the cut-over. Their only workaround is bundling webpki-roots, which ignores the user's enterprise or self-signed CA configuration, or disabling verification, which is worse.

## Recommendation

Choose and document a policy. Add the distro CA bundle paths (`/etc/ssl/certs`, `/etc/pki/tls/certs`, `/etc/ca-certificates`, `/usr/share/ca-certificates`) read-only to the landlock allow-list. On macOS, either allow `(mach-lookup (global-name "com.apple.trustd"))`, or have the host pass a PEM snapshot of the system roots into the data folder or host context at spawn. Then document in 'The plugin sandbox' how a plugin should load trust roots. Add an escape-probe-style test that a sandboxed fixture can read the CA bundle on Linux.

## Verification

Confirmed. linux.rs SYSTEM_READ_DIRS has no /etc/ssl, /etc/pki or /usr/share/ca-certificates. The macOS profile is (deny default), allows reads only under /usr/lib and /System/Library, and has no mach-lookup at all (a test asserts its absence), so /private/etc/ssl and trustd XPC are unreachable. plugin-authoring.md never mentions TLS or certificates. A plugin could in theory declare filesystemPaths:["/etc/ssl"] and read CA files through the bridge, but that does not help rustls-native-certs or Security.framework, and it is undocumented. Real gap for TLS-based backends.
