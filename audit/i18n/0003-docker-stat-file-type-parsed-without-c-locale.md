---
id: I18N-003
title: Docker file browser parses localized `stat %F` output without forcing a C locale
angle: i18n
severity: high
category: bug
is_workaround: false
subsystem: core/backends/docker/file_browser
evidence:
  - core/src/backends/docker/file_browser.rs:250
  - core/src/backends/docker/file_browser.rs:343
  - core/src/backends/docker/file_browser.rs:359
  - core/src/backends/docker/file_browser.rs:367
status: in-progress
resolution: "#2731"
---

## What
The Docker file browser runs `stat -c "%n\t%F\t%s\t%Y\t%a"` inside the container
and then decides file kind by English-substring-matching the `%F` field:

```rust
// runs: ["stat", "-c", "%n\t%F\t%s\t%Y\t%a", path]      (line 250)
let file_type = fields[1];
let is_directory = file_type.contains("directory");     // line 343
...
is_symlink: file_type.contains("symbolic link"),        // line 359
```

`%F` (GNU coreutils "file type") is a **translated** string: it is rendered
through the container's locale. Under a non-English `LANG`/`LC_ALL` in the
container it becomes e.g. `Verzeichnis` / `répertoire` / `目录` (directory) or
`symbolische Verknüpfung` / `lien symbolique` (symbolic link). No locale is
forced on the command.

The same file's `map_docker_error()` (line 365-373) classifies errors by
`lower.contains("no such file")` / `"not found"` / `"permission denied")` — also
localized stderr.

## Why it matters
Bucket A. In a container whose locale is not English (common — many base images
set `LANG` from the host, and locale is fully attacker/user-controlled):

- `is_directory` and `is_symlink` are computed as `false` for **every** entry,
  because the localized `%F` never contains the English word "directory" /
  "symbolic link". The file browser then treats directories as regular files:
  they can't be navigated into, get the wrong icon, and offer the wrong actions.
- Error mapping degrades: a permission-denied or not-found error is reported as
  a generic `OperationFailed`, losing the tailored `NotFound` /
  `PermissionDenied` handling the UI depends on.

This silently breaks a core feature (browsing files on a Docker connection) for
any non-English container.

## Evidence
- `core/src/backends/docker/file_browser.rs:250` — command built without any
  `LC_ALL=C` / `env` prefix.
- `:343` `is_directory = file_type.contains("directory")` and `:359`
  `is_symlink: file_type.contains("symbolic link")` — English-only tokens.
- `:367-370` — error classification on localized stderr.

## Recommendation
Force a stable machine locale on every parsed command and stop depending on
`%F`'s human text:

1. Prefer a **locale-invariant format**: `stat` supports numeric type bits, or
   use `find -printf`/`test`-based checks, but the simplest robust fix is to
   avoid `%F` entirely and derive type from the octal mode / a dedicated flag.
2. Regardless, prefix parsed commands with `LC_ALL=C LANG=C` (e.g.
   `env LC_ALL=C LANG=C stat …`) so any remaining text is English and numbers
   use `.`-decimals. This should be applied to every command whose output is
   parsed (see the monitoring findings for the systemic version of this).
3. Add a regression test running the browser against a container with
   `LANG=de_DE.UTF-8` (or a stubbed localized `stat` output) asserting
   directories are still detected.
