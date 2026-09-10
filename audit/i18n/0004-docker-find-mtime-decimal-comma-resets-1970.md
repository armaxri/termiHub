---
id: I18N-004
title: Docker file browser mtimes collapse to 1970 under a comma-decimal locale
angle: i18n
severity: high
category: bug
is_workaround: false
subsystem: core/backends/docker/file_browser
evidence:
  - core/src/backends/docker/file_browser.rs:178
  - core/src/backends/docker/file_browser.rs:291
  - core/src/backends/docker/file_browser.rs:308
status: in-progress
resolution: "#2731"
---

## What
`list_dir` runs `find <path> -maxdepth 1 … -printf "%f\t%y\t%s\t%T@\t%m\t%Y\t%l\n"`
inside the container (line 178) and parses the `%T@` field as an `f64`:

```rust
let mtime_float: f64 = fields[3].parse().unwrap_or(0.0);   // line 291
...
modified: chrono_from_epoch(mtime_float as u64),           // line 308
```

`%T@` is GNU findutils' *seconds-since-epoch with a fractional part*, and
findutils formats that fraction through libc honouring **`LC_NUMERIC`**. Under a
container locale like `de_DE.UTF-8` / `fr_FR.UTF-8`, `%T@` is emitted with a
**decimal comma**, e.g. `1700000000,123456789`. Rust's `f64::from_str` does not
accept a comma, so the parse fails and `unwrap_or(0.0)` sets the mtime to epoch
0. **Every file then shows a modified date of 1970-01-01.** No locale is forced
on the command.

## Why it matters
Bucket A — a concrete, user-visible bug present today. Container locale is fully
outside termiHub's control and comma-decimal locales are extremely common. In
any such container:

- The Files panel shows every entry as modified `1970-01-01`.
- Sorting by modified date is meaningless (all equal).
- The `.unwrap_or(0.0)` swallows the parse failure silently — no error, no log —
  so it looks like the container genuinely has 1970 timestamps.

This sits alongside I18N-003 (the `%F` word-match) in the same file; both stem
from parsing localized `find`/`stat` output without a forced locale.

## Evidence
- `core/src/backends/docker/file_browser.rs:178` — `find … -printf "…%T@…"`
  built with no `LC_ALL`/`LANG` prefix.
- `:291` — `let mtime_float: f64 = fields[3].parse().unwrap_or(0.0);` — comma
  decimal fails to parse, defaults to 0.
- `:308` — `chrono_from_epoch(mtime_float as u64)` renders the 1970 date.

## Recommendation
Prefix the exec'd command with `LC_ALL=C LANG=C` (e.g.
`env LC_ALL=C LANG=C find …`) so `%T@` always uses a `.` decimal — this single
change also fixes the `%F` word-match in I18N-003. Additionally, prefer an
integer-seconds field to avoid float locale issues entirely (findutils has no
integer-epoch `-printf`, but the `stat` path already uses integer `%Y` — the two
browser paths should be unified on integer epochs). Do not silently
`unwrap_or(0.0)` a failed timestamp parse; log/propagate it. Add a regression
test with `LANG=de_DE.UTF-8` output asserting mtimes survive.
