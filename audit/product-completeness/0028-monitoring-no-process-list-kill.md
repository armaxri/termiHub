---
id: PROD-028
title: System monitoring has no process list and no process kill
angle: product-completeness
severity: high
category: missing-feature
is_workaround: false
subsystem: core/monitoring, agent/monitoring
evidence:
  - core/src/monitoring/types.rs:11
status: fixed
resolution: "#3211 — process list + kill: core monitoring::process module (ProcessInfo, KillSignal TERM/KILL, typed ProcessError as {code,message,details}, ProcessManager trait, shared ExecProcessManager ps-parser cap 50, exact-pid build_kill_command), LocalProcessManager (sysinfo), agent RPC connection.processes.list/kill + RemoteProcessProxy, Tauri list_processes/kill_process + processes capability, sortable process-table modal with 5s refresh only while open + mandatory confirm dialog (pid+name) SIGTERM/SIGKILL. Follow-ups #3209 (full signal menu) / #3210 (agent-hosted remote process). Agent-hosted SSH/Docker/WSL = NotSupported (mirrors file-browser)"
---

## What
Monitoring reports only aggregate stats (CPU%, mem, disk, load, uptime). There is no top-process
list and no ability to kill a process on a monitored host. (The "kill" affordance in Open
Connections terminates termiHub sessions, not OS processes.)

## Why it matters
A monitoring feature is normally expected to show top processes and let you kill a runaway
one — a primary reason to open a monitor. Its absence makes monitoring a passive gauge only.

## Evidence
- `core/src/monitoring/types.rs:11-22` — `SystemStats` has no process fields.
- No process-enumeration/kill code in `core/src/monitoring`, `agent/src/monitoring`, `src-tauri/src/system_monitor_projection`.

## Recommendation
Add a process-list collector (SSH `ps`/agent-native) with sortable CPU/mem columns and a
kill/signal action, surfaced in the monitoring panel.
