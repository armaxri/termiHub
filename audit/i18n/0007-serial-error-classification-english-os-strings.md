---
id: I18N-007
title: Serial-port error classification matches localized OS error text
angle: i18n
severity: medium
category: bug
is_workaround: false
subsystem: core/session/serial
evidence:
  - core/src/session/serial.rs:166
  - core/src/session/serial.rs:168
  - core/src/session/serial.rs:173
status: fixed
resolution: "#2802 — serial open errors classified by ErrorKind/raw_os_error (errno) not localized text; english fallback only for busy"
---

## What
`open_serial_port` maps a failed open to a friendly message. It correctly
handles `std::io::ErrorKind::NotFound` and `PermissionDenied` via the
locale-independent `ErrorKind` enum, but the fallback branch classifies by
English-substring-matching the raw OS error string:

```rust
_ => {
    let desc = e.to_string();
    if desc.contains("busy") || desc.contains("in use")
        || desc.contains("Access is denied") {            // line 168
        // "already in use by another application"
    } else if desc.contains("not found")
        || desc.contains("cannot find")
        || desc.contains("No such file") {                 // line 173
        // "not found"
    } else { /* generic */ }
}
```

`desc` comes from `serial2`/`std::io::Error`, which on Windows is produced by
`FormatMessage` and is **localized to the OS display language** ("Access is
denied" → "Zugriff verweigert" on German Windows; "in use" wording varies).

## Why it matters
Bucket A. On a non-English Windows, an already-in-use serial port does not match
`"busy"`/`"in use"`/`"Access is denied"`, so it falls through to the generic
`"Failed to open serial port …: <raw>"` message instead of the actionable
"already in use by another application" guidance. The "busy" condition in
particular has **no stable `ErrorKind` variant** (`ResourceBusy` is unstable), so
this substring branch is the only thing distinguishing it — and it's exactly the
branch that breaks under localization. Serial is a first-class connection type;
degraded diagnostics on non-English Windows is a real UX regression.

## Evidence
`core/src/session/serial.rs:166-181` — the `_ =>` fallback string-matches
localized OS text. (The `NotFound`/`PermissionDenied` arms above it are correct
and locale-safe — good; the gap is only the "busy" path.)

## Recommendation
Avoid matching localized OS text. Options, best first:
1. Match on the OS **raw error code** rather than the message —
   `e.raw_os_error()` (Windows `ERROR_ACCESS_DENIED = 5`, `ERROR_BUSY`,
   `ERROR_SHARING_VIOLATION = 32`) is locale-invariant.
2. Where `serial2` exposes a typed error kind for "busy", switch on that.
3. Keep the English-substring path only as a last-resort heuristic behind the
   code checks. Add a Windows regression test asserting a sharing-violation code
   maps to the "in use" message.
