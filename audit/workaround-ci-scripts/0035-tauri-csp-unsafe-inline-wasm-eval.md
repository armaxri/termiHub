---
id: WA-CI-035
title: Production CSP allows style-src 'unsafe-inline' and script-src 'wasm-unsafe-eval'
angle: workaround-ci-scripts
severity: low
category: security
is_workaround: true
subsystem: src-tauri/tauri.conf.json
evidence:
  - src-tauri/tauri.conf.json:25
status: open
---

## What
The shipped CSP in `tauri.conf.json` (line 25) includes `style-src 'self' 'unsafe-inline'`,
`script-src 'self' plugin://localhost http://plugin.localhost 'wasm-unsafe-eval'`, and
`img-src 'self' data: blob:`. `'unsafe-inline'` for styles and `'wasm-unsafe-eval'` for scripts
are relaxations of a strict CSP, and `http://plugin.localhost` (plaintext scheme) is allowed
alongside the `plugin://` scheme for the plugin system.

## Why it matters
`style-src 'unsafe-inline'` is a common but real relaxation (permits injected inline styles);
`'wasm-unsafe-eval'` widens the script policy to allow WebAssembly compilation. On a
safety-critical app these are worth a conscious sign-off rather than defaults. The `devUrl`
(`http://localhost:1420`) and `beforeDevCommand` are dev-only and not shipped, but the CSP is.
(Note: the test-bridge further relaxes this CSP at runtime — see WA-CI-027.)

## Why it may be necessary
Many UI toolkits/Monaco/styled-components need inline styles, and wasm-unsafe-eval is required if
any dependency instantiates WASM. So these may be load-bearing, not gratuitous.

## Evidence
`"csp": "… style-src 'self' 'unsafe-inline'; script-src 'self' plugin://localhost
http://plugin.localhost 'wasm-unsafe-eval'; …"` (tauri.conf.json:25).

## Recommendation
Verify each relaxation is actually required: if no dependency needs WASM, drop
`'wasm-unsafe-eval'`; if inline styles can be nonce/hash-based, tighten `style-src`. Confirm the
plaintext `http://plugin.localhost` origin is required (vs. only `plugin://`). Document the ones
that must stay as a reviewed security sign-off. Low.
