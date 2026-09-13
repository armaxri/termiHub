---
id: PROD-034
title: Embedded servers (HTTP/FTP/TFTP) have no access/request logging
angle: product-completeness
severity: medium
category: missing-feature
is_workaround: false
subsystem: core/embedded_servers
evidence:
  - src/types/embeddedServer.ts:27
status: open
---

## What
None of the embedded server types expose an access log or request history. Only aggregate
`status` + `stats` are surfaced.

## Why it matters
Anyone running a file-serving daemon wants to see who connected and what was requested — for
verification ("did the device fetch the firmware?") and troubleshooting.

## Evidence
- No `access_log/request_log/logging` in `core/src/embedded_servers`, `src-tauri/src/embedded_servers`, `agent/src/service`.
- `src/types/embeddedServer.ts:27-42` — only status + stats, no log view.

## Recommendation
Capture per-request log lines (client, method/path, status, bytes) and show a live access-log
panel per server, with export.
