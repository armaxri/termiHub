---
id: MKT2-004
title: "README SSH Configuration section is stale: only 2 of 4 auth methods, wrong default, no 2FA or agent forwarding"
angle: marketing / product positioning
severity: medium
category: docs-accuracy
is_workaround: false
subsystem: "README.md / SSH"
evidence:
  - "README.md:452-457"
  - "README.md:518-525"
  - "README.md:98"
  - "core/src/backends/ssh/mod.rs:357-385"
  - "core/src/backends/ssh/mod.rs:286"
  - "core/src/backends/ssh/mod.rs:475"
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

README.md:454 says 'termiHub supports **Password** and **SSH Key** authentication'. README.md:456 says 'termiHub prompts for the password each time you connect', which conflicts with the credential store described elsewhere. The settings table (README.md:518-525) lists Auth Method `password` or `key` with default `password`. The real schema field is labelled 'Method' and offers SSH Key, Password, SSH Agent and 'Keyboard-Interactive (OTP / 2FA)', with default `key` (ssh/mod.rs:357-385). Its X11 field is labelled 'X11 Forwarding' (ssh/mod.rs:475), not 'Enable X11 Forwarding'. SSH agent forwarding (`forwardAgent`, ssh/mod.rs:286) and the per-connection Shell Integration toggle appear nowhere in the README; Features line :98 lists only key and password auth.

## Why it matters

2FA/OTP (keyboard-interactive) and ssh-agent support are things infrastructure users check before adopting an SSH client. The README says they are missing. The wrong default and field names also mislead the very users who follow the docs step by step.

## Evidence

- `README.md:452-457`
- `README.md:518-525`
- `README.md:98`
- `core/src/backends/ssh/mod.rs:357-385`
- `core/src/backends/ssh/mod.rs:286`
- `core/src/backends/ssh/mod.rs:475`

## Recommendation

Rewrite 'Authentication Methods' to list all four methods (SSH Key, Password with optional credential-store save, SSH Agent, Keyboard-Interactive for OTP/2FA/PAM prompts). Fix the table: label 'Method', default `key`, add the SSH Agent and Keyboard-Interactive values, add rows for Forward SSH Agent and Shell Integration, and rename 'Enable X11 Forwarding' to 'X11 Forwarding'. Change Features line :98 to 'key, password, ssh-agent and keyboard-interactive (OTP/2FA) authentication, agent forwarding'.

## Verification

Confirmed. README:454 lists only Password and SSH Key, and the table at :522 says `password` or `key` with default password. ssh/mod.rs:357-385 has label 'Method', four options (key/password/agent/keyboard-interactive) and default key. Line 475 labels the field 'X11 Forwarding', and forwardAgent exists at :286 but is absent from the README.
