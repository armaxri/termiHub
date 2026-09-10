---
id: SEC-013
title: Tauri capability grants unscoped filesystem read/write and open-path to the webview (least privilege)
angle: security
severity: medium
category: security
is_workaround: false
subsystem: src-tauri/capabilities
evidence:
  - src-tauri/capabilities/default.json:10
  - src-tauri/capabilities/default.json:12
  - src-tauri/tauri.conf.json:25
status: open
---

## What

The single `default` capability grants the main (and all `win-*`) webviews broad,
**unscoped** filesystem and opener permissions:

```json
// src-tauri/capabilities/default.json
"opener:allow-open-path",
"fs:default",
"fs:allow-write-text-file",
"fs:allow-read-text-file",
```

None of these carry a `scope`/`allow`/`deny` restriction, so the frontend can ask
the Tauri core plugins to read or overwrite arbitrary text files the process can
access, and to open arbitrary paths — no directory allowlist. The CSP also carries
`'wasm-unsafe-eval'` in `script-src`, `'unsafe-inline'` in `style-src`, and
`dangerousDisableAssetCspModification: ["style-src"]`
(`tauri.conf.json:25-26`), each a small relaxation of the default hardening.

## Why it matters

Defense-in-depth. The app's own commands mediate most file access, but these
capability grants are a *parallel*, unscoped path straight from webview JS to the
OS via the Tauri core plugins. If any XSS or a compromised frontend dependency ever
runs in the webview (none found today — see SEC-012 — but this is the layer that
contains such a compromise), unscoped `fs:allow-read-text-file` /
`fs:allow-write-text-file` / `opener:allow-open-path` turn it into arbitrary
file read/write and path-open. For a safety-critical release the webview
capabilities should be the tightest layer, not the loosest. Least privilege here
is cheap insurance.

## Evidence

- `src-tauri/capabilities/default.json:6-21` — `fs:default`,
  `fs:allow-write-text-file`, `fs:allow-read-text-file`, `opener:allow-open-path`
  with no scope block; also applied to `win-*` secondary windows.
- `src-tauri/tauri.conf.json:25-26` — `'wasm-unsafe-eval'`, `'unsafe-inline'`
  style, and `dangerousDisableAssetCspModification`.

## Recommendation

Scope the filesystem permissions to the specific directories the frontend legitimately
needs (Tauri v2 `fs` scope `allow`/`deny` globs — e.g. the app config/data dirs
and the user-chosen file for editor saves via the dialog's returned path), and
prefer routing file I/O through the app's own audited commands so the broad `fs:*`
grants can be dropped entirely. Scope or remove `opener:allow-open-path` (keep only
`opener:allow-open-url` gated to http(s) if that is all that is needed). Re-justify
each remaining permission against least privilege, and document why
`'wasm-unsafe-eval'` is required (xterm/WebGL?) or drop it. Split per-window
capabilities so `win-*` windows get only what they need.
