# Sync Ledger — X Server Provisioning

**Last synced:** never (concept not yet implemented)
**Status:** diverged (entirely missing — backlog feature)

This ledger is maintained by the `/sync-concept x-server-provisioning` skill. It records the last
commit at which the concept artifacts and the code were reconciled, plus any open divergences.

## Open divergences

| #   | Artifact claim                                                 | Code reality                                             | Type     | Recommendation                                     |
| --- | -------------------------------------------------------------- | -------------------------------------------------------- | -------- | -------------------------------------------------- |
| 1   | X server provisioning subsystem (`src-tauri/.../xserver/`)     | Not implemented — backlog feature                        | Missing  | Implement per `concept.md` order, then re-sync     |
| 2   | Managed-server-aware detection + Windows TCP:6000 probe        | `x11.rs` scans `/tmp/.X11-unix` + shells to `xauth` only | Diverged | Extend `detect_local_x_server` / cookie lookup     |
| 3   | Settings `provideXServerAutomatically` / `stopXServerWhenIdle` | Not present in SSH schema                                | Missing  | Add schema fields once orchestrator lands          |
| 4   | "X Servers" section in Open Connections panel                  | Not present in `OpenConnectionsModal.tsx`                | Missing  | Add `Section` after backend command surface exists |

## Resolved

| Date | #   | Resolution |
| ---- | --- | ---------- |
| —    | —   | —          |
