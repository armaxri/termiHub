---
id: UX-008
title: SSH connection form shows all advanced fields expanded with no progressive disclosure
angle: ux-flows
severity: medium
category: ux
is_workaround: false
subsystem: src/components/DynamicForm
evidence:
  - src/components/DynamicForm/ConnectionSettingsForm.tsx:239
  - core/src/backends/ssh/mod.rs:251
status: fixed
resolution: "#2824 — SettingsGroup gained serde-default collapsed hint; SSH Advanced group collapsed behind accessible expander (fields stay mounted)"
---

## What
The schema-driven connection form renders every field group fully expanded at once
(`ConnectionSettingsForm.tsx:239-282` — no collapse), plus the Jump Host / Agent Forwarding /
SSH-config-import sections (`ConnectionEditor.tsx:1240-1344`). For a basic key-auth SSH connection
the user only *needs* ~4 inputs (Name, Host, Username, Key Path — Port and Method have defaults),
but the pane presents ~13 fields including 7 Advanced ones (shell, X11 forwarding, connect timeout,
env, shell integration, resilient reconnect, on-reconnect command; groups defined at
`core/src/backends/ssh/mod.rs:251-548`).

## Why it matters
The essential fields are buried in a wall of advanced options. There is no wizard and no collapsed
"Advanced" section, so perceived complexity is high for the most common task (add a simple SSH
host). Progressive disclosure would substantially lower the barrier to the primary journey.

## Evidence
- `ConnectionSettingsForm.tsx:239-282` — all schema groups render expanded, no collapse control.
- `core/src/backends/ssh/mod.rs:251-548` — 3 groups; the Advanced group holds 7 fields.
- Positive: sensible defaults do exist (port 22, auth `key`, X11 on, shell integration on) — see
  `mod.rs:278,325,416,487`.

## Recommendation
Collapse the Advanced group (and Jump Host / Agent Forwarding) by default, showing only Name +
Connection (host/port/username) + Authentication for a new connection, with an "Advanced" expander.
The DynamicForm group model can carry a `collapsed`/`advanced` hint per group.
