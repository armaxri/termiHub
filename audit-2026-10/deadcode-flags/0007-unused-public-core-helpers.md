---
id: DEAD2-007
title: "Public core helpers with no production caller, one with a doc comment that names callers that do not exist"
angle: deadcode-flags
severity: low
category: dead-code
is_workaround: false
subsystem: "core (session, plugin, monitoring, files, service)"
evidence:
  - core/src/session/ssh.rs:16
  - core/src/session/ssh.rs:26
  - core/src/session/shell.rs:46
  - core/src/session/shell.rs:493
  - core/src/session/shell.rs:156
  - core/src/plugin/connection.rs:153
  - core/src/plugin/connection.rs:160
  - core/src/plugin/capabilities.rs:220
  - core/src/plugin/capabilities.rs:242
  - core/src/plugin/security.rs:207
  - core/src/plugin/sandbox/exit.rs:217
  - core/src/files/transfer/scheduler.rs:64
  - core/src/service/registry.rs:108
  - core/src/monitoring/http_monitor.rs:441
  - core/src/monitoring/process.rs:152
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

termihub-core is a library crate, so `pub` items never trigger dead_code warnings. Searching core, src-tauri, agent, rdp-sidecar, plugin-runner and plugins turns up no non-test caller for: build_ssh_args (its doc at ssh.rs:16 claims 'Used by the agent's daemon approach (primary) and potentially by the desktop'; nothing uses it); initial_command_strategy plus the InitialCommandStrategy enum; windows_default_shell_kind; PluginConnection::require_permission / resolve_scoped_path (permissions are actually enforced in capabilities.rs:220/242, so these are an unused second enforcement seam); FilesystemScope::is_granted; exit budget is_exhausted; TransferScheduler::is_idle; ServiceRegistry::has_service; HttpMonitorService::observer_count; KillSignal::is_destructive (the UI has its own isDestructiveSignal in src/components/StatusBar/killSignals.ts:43).

## Why it matters

Each of these is small. Together they are speculative API surface with tests that keep it looking alive. The build_ssh_args doc names callers that do not exist. The duplicate plugin-permission seam is the riskier one: a future capability author may call the unused connection.rs wrapper and assume it matches capabilities.rs, so a fix to one path can miss the other.

## Evidence

- `core/src/session/ssh.rs:16`
- `core/src/session/ssh.rs:26`
- `core/src/session/shell.rs:46`
- `core/src/session/shell.rs:493`
- `core/src/session/shell.rs:156`
- `core/src/plugin/connection.rs:153`
- `core/src/plugin/connection.rs:160`
- `core/src/plugin/capabilities.rs:220`
- `core/src/plugin/capabilities.rs:242`
- `core/src/plugin/security.rs:207`
- `core/src/plugin/sandbox/exit.rs:217`
- `core/src/files/transfer/scheduler.rs:64`
- `core/src/service/registry.rs:108`
- `core/src/monitoring/http_monitor.rs:441`
- `core/src/monitoring/process.rs:152`

## Recommendation

Delete the unused helpers and their unit tests, or demote them to pub(crate) so rustc's dead_code lint covers them from now on. If a helper is meant as a seam (e.g. require_permission), route capabilities.rs through it so there is exactly one enforcement path. Fix or remove the ssh.rs module doc.

## Verification

Confirmed. Searching core, src-tauri, agent, rdp-sidecar, plugin-runner and plugins, the only references to build_ssh_args, initial_command_strategy, windows_default_shell_kind, is_exhausted, is_idle, has_service, observer_count and is_destructive are in in-file #[cfg(test)] modules. require_permission, resolve_scoped_path and is_granted have no references besides their definitions. Because these are pub items in a library crate, rustc's dead_code lint never flags them. The duplicate plugin-permission seam is a maintainability risk, not a bug that exists today.
