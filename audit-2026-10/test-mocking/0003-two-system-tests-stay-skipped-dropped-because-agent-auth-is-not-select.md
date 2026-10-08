---
id: MOCK2-003
title: "Two system tests stay skipped/dropped because 'agent auth is not selectable', but the SSH schema offers 'agent' as an authMethod"
angle: test-mocking
severity: low
category: test-gap
is_workaround: true
subsystem: "tests/system (SSH agent-auth error path)"
evidence:
  - tests/system/tests/test_ssh_agent_error.py:15
  - tests/system/tests/test_ssh_agent_error.py:4
  - tests/system/tests/test_connection_forms.py:18
  - core/src/backends/ssh/mod.rs:372
  - core/src/backends/ssh/auth.rs:250
  - src/components/ConnectionEditor/ConnectionEditor.tsx:456
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

`test_ssh_agent_error.py` is unconditionally `@pytest.mark.skip(reason="agent auth is not a selectable authMethod option")`, and its docstring says the schema exposes only key/password. `test_connection_forms.py:18` drops MT-SSH-08 (the agent-auth warning) for the same reason and points to the skipped file. The SSH ConnectionType schema does offer `SelectOption { value: "agent", label: "SSH Agent" }` (core/src/backends/ssh/mod.rs:372). It has done so since #357, the commit that implemented the SSH ConnectionType in core. Auth dispatches on it (auth.rs:250), and the editor renders the 'Setup SSH Agent' helper for it (ConnectionEditor.tsx:456).

## Why it matters

Both skips rest on a false premise, so the user-visible path for agent auth when no agent is running (the error and warning feedback) has no end-to-end coverage. The skip reads as a removed feature, so nobody revisits it. This is the 'skip hides failure' pattern the nightly-lane lessons warn about.

## Recommendation

Un-skip `test_agent_auth_shows_helpful_error_when_no_agent`. Select `authMethod=agent` through the editor, launch the app for that class with `SSH_AUTH_SOCK` unset, and assert the graceful error. Restore the MT-SSH-08 warning check in test_connection_forms.py. Correct both docstrings.

## Verification

Confirmed. core/src/backends/ssh/mod.rs:372 offers SelectOption value 'agent' / label 'SSH Agent'. Yet test_ssh_agent_error.py is unconditionally skipped, and its docstring claims the schema exposes only key/password. test_connection_forms.py drops MT-SSH-08 on the same false premise and even cites ssh/mod.rs. The skip rests on a stale or false rationale and hides end-to-end coverage of agent-auth error feedback.
