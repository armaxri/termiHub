---
id: I18N2-003
title: "New sort sites bypass the shared compareNames collator (non-natural, locale-default ordering)"
angle: i18n
severity: low
category: collation
is_workaround: false
subsystem: "src/components (RemoteDesktop, DynamicForm, Plugins)"
evidence:
  - src/components/RemoteDesktop/browseRemoteFiles.ts:110
  - src/components/DynamicForm/dockerContainerGroups.ts:37
  - src/components/DynamicForm/dockerContainerGroups.ts:68
  - src/components/Plugins/pluginPlatforms.ts:75
  - src/utils/locale.ts:103
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: regression
previous_id: I18N-014
---

## What

The I18N-014 fix routed every name sort through `compareNames()`, an
`Intl.Collator(resolveUiLocale(), {numeric:true, sensitivity:'base'})`. Code
added since then calls raw `localeCompare` with no locale or options: the
remote-desktop "Upload to folder…" listing (#4204), Docker container/Compose
project and service grouping (#3784), and the plugin platform list.

## Why it matters

These lists sort `dir10` before `dir2` and `web-10` before `web-2`, and use the
engine's default locale rather than the validated UI locale. The remote-desktop
folder picker therefore orders the same folders differently from the File
Browser, which does use compareNames. Docker Compose replicas named
`svc-1..svc-12` appear out of order. The fixed invariant is silently eroding
with no guard.

## Evidence

- `src/components/RemoteDesktop/browseRemoteFiles.ts:110`
- `src/components/DynamicForm/dockerContainerGroups.ts:37`
- `src/components/DynamicForm/dockerContainerGroups.ts:68`
- `src/components/Plugins/pluginPlatforms.ts:75`
- `src/utils/locale.ts:103`

## Recommendation

Replace these comparators with `compareNames` from `@/utils/locale`. In
dockerContainerGroups, the lower-case-then-exact tie-break becomes
`compareNames(a,b) || (a < b ? -1 : a > b ? 1 : 0)`. Add a lint rule (no-
restricted-syntax on `CallExpression[callee.property.name='localeCompare']`
outside locale.ts) or a source-scanning vitest, like main.importOrder.test.ts,
so new sites cannot bypass it.

## Verification

Confirmed. All three sites call bare localeCompare with no locale or options:
browseRemoteFiles.ts:110, dockerContainerGroups.ts:37-38 and 68-69, and
pluginPlatforms.ts:75. compareNames in locale.ts provides numeric, base-
sensitivity collation with resolveUiLocale, and the File Browser and other sites
already use it. These are the only remaining non-test localeCompare calls. No
lint or test guard exists. The plugin platform list barely matters, but the
remote folder picker and Docker grouping show the numeric-ordering regression.
