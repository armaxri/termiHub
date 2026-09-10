---
id: I18N-006
title: FTP directory listing parser breaks on localized `ls -l` month names
angle: i18n
severity: low
category: bug
is_workaround: false
subsystem: core/backends/ftp/listing_parser
evidence:
  - core/src/backends/ftp/listing_parser.rs:143
  - core/src/backends/ftp/listing_parser.rs:199
status: open
---

## What
`ListParser::parse_posix()` parses classic Unix `ls -l`-style FTP `LIST` output,
whose date column uses abbreviated English month names (`Jan`, `Feb`, …). If the
FTP server emits localized month names (`janv.`, `Mär`, `十月`), the date column
does not match and the modified time falls back to an empty string
(`modified_iso`, lines 199-204).

## Why it matters
Bucket A but narrow. The mtime originates from the FTP *server's* locale, which
the client cannot force (unlike the SSH/Docker cases). So this is only partially
in termiHub's control, and the failure mode is a **missing/blank modified date**
rather than a crash — entries still list. Impact is limited to non-English FTP
servers using the legacy `LIST` format (MLSD-capable servers are unaffected —
MLSD uses a locale-invariant timestamp).

## Evidence
- `core/src/backends/ftp/listing_parser.rs:143` — `parse_posix(line)` parses the
  month-name date column.
- `:199-204` — on parse failure the ISO mtime is left empty.

## Recommendation
Prefer **MLSD** (RFC 3659) whenever the server advertises it — its `modify` fact
is a locale-invariant `YYYYMMDDHHMMSS` timestamp and sidesteps month-name
parsing entirely. For servers that only support `LIST`, treat an unparseable
date as "unknown" gracefully (already the behavior) and document the limitation.
This is lower priority than the SSH/Docker locale fixes because the client can't
control the server locale.
