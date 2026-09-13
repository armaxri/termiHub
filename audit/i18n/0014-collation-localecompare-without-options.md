---
id: I18N-014
title: Filename/host sorting uses default localeCompare (no collation options)
angle: i18n
severity: low
category: i18n
is_workaround: false
subsystem: src/utils, src/components (sort sites)
evidence:
  - src/utils/fileBrowserNav.ts:83
  - src/hooks/useSshKeyFiles.ts:62
  - src/services/sshConfigImport.ts:126
status: open
---

## What
All string sorting in the frontend routes through `String.prototype.localeCompare`
with **no locale or options argument**, so it uses the runtime default collator.
Sites include filename sorting (`fileBrowserNav.ts:83,85`), SSH key filenames
(`useSshKeyFiles.ts:62`), imported SSH host labels (`sshConfigImport.ts:126`),
jump-host labels (`jumpHost.ts:159`), fleet host labels (`FleetOnboardDialog.tsx:62`),
connection-icon display names (`connectionIcons.tsx:186`), Monaco language names,
and file-extension keys (`FileTypeSettings.tsx:31`).

## Why it matters
Bucket B, low. This is the *good* pattern versus raw `<`/`>` (no raw string
sorts were found — credit where due). But because no options are passed:

- Ordering of non-ASCII filenames/hosts varies with the runtime locale (which,
  per I18N-013, can be `C`/`POSIX` → effectively code-point order). Results are
  cosmetically inconsistent across environments.
- No `{ numeric: true }`, so `file2` / `file10` sort lexically (`file10` before
  `file2`) — a common file-browser annoyance unrelated to language.
- No `{ sensitivity }` control, so case/accent handling is whatever the default
  collator does.

No correctness impact — purely display ordering.

## Evidence
See the sort sites above; representative: `src/utils/fileBrowserNav.ts:83`
`cmp = a.name.localeCompare(b.name);` with no second/third argument.

## Recommendation
Introduce a single shared collator (e.g. `new Intl.Collator(resolveUiLocale(),
{ numeric: true, sensitivity: "base" })`) and sort through it everywhere,
especially for filenames where `numeric: true` gives natural `file2 < file10`
ordering. Use the guarded `resolveUiLocale()` (never the bare default) so a
`C`-locale host gets deterministic, sensible ordering. Low priority; batch with
the formatter cleanup (I18N-015).
