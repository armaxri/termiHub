---
id: PROD-035
title: Embedded HTTP server has no authentication (FTP does)
angle: product-completeness
severity: medium
category: missing-feature
is_workaround: false
subsystem: core/embedded_servers, src/components/EmbeddedServerSidebar
evidence:
  - src/types/embeddedServer.ts:13
  - src/components/EmbeddedServerSidebar/EmbeddedServerDialog.tsx:269
status: open
---

## What
The embedded HTTP server exposes only a directory-listing toggle — no basic auth. FTP has an
authenticator, but HTTP does not, so an exposed HTTP share is unauthenticated to anyone on the
bind interface.

## Why it matters
Serving files over HTTP without any password is a security/usability gap when the bind
interface is non-loopback.

## Evidence
- `src/types/embeddedServer.ts:13-24` — `ftpAuth` field but no HTTP auth.
- `src/components/EmbeddedServerSidebar/EmbeddedServerDialog.tsx:110-114, 269-282` — auth UI gated to FTP only.

## Recommendation
Add optional HTTP basic-auth (user/password) to the embedded HTTP server config and dialog.
