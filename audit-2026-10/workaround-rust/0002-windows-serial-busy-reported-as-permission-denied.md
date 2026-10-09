---
id: WA-RS2-002
title: "Windows serial port 'in use' is reported as 'Permission denied': the English fallback is unreachable and the frontend hint papers over it"
angle: workaround-rust
severity: low
category: workaround-layering
is_workaround: true
subsystem: core/session/serial
evidence:
  - core/src/session/serial.rs:159
  - core/src/session/serial.rs:189
  - core/src/session/serial.rs:200
  - core/src/session/serial.rs:296
  - src/utils/connectionErrorHints.ts:177
  - src/i18n/catalog.ts:44
status: fixed
resolution: "#4368 — Windows ERROR_ACCESS_DENIED on serial open now classified as Busy (raw code before ErrorKind); dead substring branch removed; Windows permission hint reduced to a real permission message"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

On Windows, a COM port already held by another process makes CreateFile fail with
ERROR_ACCESS_DENIED (5). Std maps that to `ErrorKind::PermissionDenied`.
`classify_open_error` checks the error kind first and returns
`SerialOpenError::PermissionDenied` (serial.rs:159), and the raw-code branch also
maps 5 to PermissionDenied (serial.rs:189). The last-resort English check,
`desc.contains("Access is denied") => Busy` (serial.rs:200), encodes the correct
knowledge but can never run, because the earlier branches always catch this
error. The backend therefore sends `ConnectFailureKind::PermissionDenied` with
"Permission denied on 'COM3'". The frontend compensates with a Windows-only
permission hint that says "Another application may be using the port..."
(catalog.ts:44, connectionErrorHints.ts:177).

## Why it matters

The most common Windows serial failure (port open in another program) gets the
wrong typed kind and a misleading headline, and the Busy kind with its dedicated
hint is never produced there. Fixing one layer without the other would regress
the UX. The dead English branch suggests a Busy mapping that does not exist.

## Recommendation

Under `cfg(windows)`, classify ERROR_ACCESS_DENIED from a serial open as `Busy`.
Standard users have no per-port ACL problem on COM ports, so access-denied there
means exclusive use in practice. Alternatively add a `BusyOrPermission` kind. Do
this before the generic `ErrorKind::PermissionDenied` match. Delete the
unreachable "Access is denied" substring branch and update the Windows test that
asserts code 5 maps to PermissionDenied (serial.rs:1049-1052). Then reduce the
frontend's Windows permission hint to a real permission message.

## Verification

Confirmed. classify_open_error returns PermissionDenied on
ErrorKind::PermissionDenied (serial.rs:159), and std maps Windows code 5 to that
kind. The raw-code arm also maps ERROR_ACCESS_DENIED to PermissionDenied (189),
and a test pins this at ~1049. So the `desc.contains("Access is denied") => Busy`
fallback (200) can never fire for that error. The frontend Windows permission
hint (catalog.ts:44, commented as #1831) deliberately says another app may hold
the port, so users still get usable guidance. The defect is the wrong typed kind
and headline plus a dead branch. Low severity.
