---
id: PROD-031
title: Network tool results cannot be exported/saved
angle: product-completeness
severity: medium
category: missing-feature
is_workaround: false
subsystem: src/components/NetworkTools
evidence:
  - src/components/NetworkTools/PortScanPanel.tsx:1
status: fixed
resolution: "#3120 — network-tool result export: Export control (Download btn, disabled when empty) on Ping/Traceroute/PortScanner/DNS panels → CSV via shared src/components/NetworkTools/exportResults.ts using same save()+writeTextFile() path as LogViewer (no new file-write). RFC-4180 escaped, sanitized filenames, toast success/error, cancel=no-op. WoL/HTTP-Monitor excluded (no discrete result set). 10 new tests"
---

## What
No network tool (ping, traceroute, port scan, DNS, sweep, open-ports) offers export/save to
file. Results are on-screen only.

## Why it matters
Users run these tools to produce evidence (a port-scan/traceroute report to share or archive).
Copy-by-hand is the only option.

## Evidence
- No `export/.csv/download/saveAs/writeFile` in `src/components/NetworkTools/*.tsx`.

## Recommendation
Add "Export results" (CSV/JSON/text) to each tool panel via the existing save-file dialog.
