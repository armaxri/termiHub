---
id: DEAD2-003
title: "24 registered Tauri IPC commands have no production caller; only their api.ts wrappers' unit tests invoke them"
angle: deadcode-flags
severity: medium
category: dead-code
is_workaround: false
subsystem: "src-tauri/commands + src/services/*Api.ts"
evidence:
  - src/services/api.ts:536
  - src/services/api.ts:1125
  - src/services/api.ts:1164
  - src/services/api.ts:1211
  - src/services/api.ts:1238
  - src/services/api.ts:1284
  - src/services/api.ts:1347
  - src/services/api.ts:1352
  - src/services/api.ts:1557
  - src/services/api.ts:1728
  - src/services/api.ts:1746
  - src/services/api.ts:2459
  - src/services/api.ts:2491
  - src/services/api.ts:2582
  - src/services/api.ts:2593
  - src/services/api.ts:2789
  - src/services/api.ts:3061
  - src/services/api.ts:3129
  - src/services/tunnelApi.ts:9
  - src/services/tunnelApi.ts:24
  - src/services/macroApi.ts:14
  - src/services/workflowApi.ts:17
  - src/services/workspaceApi.ts:76
  - src/services/networkApi.ts:242
  - src-tauri/src/lib.rs:728
  - src-tauri/src/lib.rs:729
  - src-tauri/src/lib.rs:743
  - src-tauri/src/lib.rs:829
  - src-tauri/src/lib.rs:980
  - src-tauri/src/commands/connection.rs:291
  - src-tauri/src/commands/connection.rs:335
status: fixed
resolution: "#4344 — 24 orphan commands and wrappers removed (probe_remote_agent deferred to #4570); check-invoke-contract.mjs now fails on orphans"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

I diffed every frontend invoke() against generate_handler!. All 395 registered commands have an api wrapper, but these 24 wrappers have zero callers in production code: get_session_owner, list_persistent_sessions, check_x11_available, check_ssh_agent_status, list_docker_images, list_podman_images, export_connections, import_connections, save_external_file, ftp_download, ftp_upload, get_agent_capabilities, list_agent_definitions, probe_remote_agent, deploy_agent, setup_master_password, resolve_portable_path_cmd, get_update_settings, get_macro, get_workflow, get_tunnels, get_tunnel_statuses, preview_import_workspaces, set_http_monitor_run_location. Only api*.test.ts reaches them; ftp_download is also driven by the Python system harness. Most have a live replacement: export_connections_encrypted / import_connections_with_credentials (ExportDialog/ImportDialog), update_agent* (UpdateAgentDialog), get_session_owners, the tunnels/agents projection regions, and the X-server status commands.

## Why it matters

Every registered command can be called by any script running in the main webview. Several of these dead ones are high-value: export_connections returns the whole connection store, import_connections skips the credential-aware import flow, save_external_file writes a connections file to a caller-chosen path, and deploy_agent pushes a binary over SSH. Keeping unreachable copies of superseded flows enlarges the IPC attack surface and the maintenance surface, and the wrapper unit tests make them look covered.

## Evidence

- `src/services/api.ts:536`
- `src/services/api.ts:1125`
- `src/services/api.ts:1164`
- `src/services/api.ts:1211`
- `src/services/api.ts:1238`
- `src/services/api.ts:1284`
- `src/services/api.ts:1347`
- `src/services/api.ts:1352`
- `src/services/api.ts:1557`
- `src/services/api.ts:1728`
- `src/services/api.ts:1746`
- `src/services/api.ts:2459`
- `src/services/api.ts:2491`
- `src/services/api.ts:2582`
- `src/services/api.ts:2593`
- `src/services/api.ts:2789`
- `src/services/api.ts:3061`
- `src/services/api.ts:3129`
- `src/services/tunnelApi.ts:9`
- `src/services/tunnelApi.ts:24`
- `src/services/macroApi.ts:14`
- `src/services/workflowApi.ts:17`
- `src/services/workspaceApi.ts:76`
- `src/services/networkApi.ts:242`
- `src-tauri/src/lib.rs:728`
- `src-tauri/src/lib.rs:729`
- `src-tauri/src/lib.rs:743`
- `src-tauri/src/lib.rs:829`
- `src-tauri/src/lib.rs:980`
- `src-tauri/src/commands/connection.rs:291`
- `src-tauri/src/commands/connection.rs:335`

## Recommendation

For each command, confirm it is superseded and then delete the wrapper, its unit-test case, the #[tauri::command] and the generate_handler! entry. Keep ftp_download only if the system harness needs it, and in that case move it behind #[cfg(feature = "test-bridge")]. Add a CI check, e.g. a small script that diffs generate_handler! against invoke() call sites in non-test src/, to stop new orphans appearing.

## Verification

Spot-checked all 24 wrappers. Each is defined in api.ts or a \*Api.ts file and the command is registered in generate_handler! (e.g. export_connections lib.rs:728, deploy_agent :829, setup_master_password :980). None has a non-test caller in src/; listAgentDefinitions appears only in a wire-fixture JSON. Medium rather than high: the attack-surface argument is partly moot because live equivalents with similar power are also registered. Still, save_external_file (arbitrary path write) and import_connections (skips the credential-aware import flow) are real unreachable surface.
