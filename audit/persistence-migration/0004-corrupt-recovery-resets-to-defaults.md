---
id: PER-004
title: Corrupt/unrecognized store resets to defaults; a downgrade silently wipes the file to .bak
angle: persistence-migration
severity: high
category: reliability
is_workaround: false
subsystem: src-tauri/src/workspace, src-tauri/src/session_history
evidence:
  - src-tauri/src/workspace/storage.rs:60
  - src-tauri/src/session_history/storage.rs:56
  - src-tauri/src/workspace/last_session.rs:77
  - src-tauri/src/connection/storage.rs:135
status: fixed
resolution: "#2746 — newer-file-not-wiped"
---

## What

The recovery strategy for the JSON stores is "parse, or reset to defaults." On any deserialize
failure the store copies the file to `<name>.json.bak` and then **overwrites the live file with an
empty default store**:

- `workspace/storage.rs:52-78` — corrupt → `.bak`, then `save(WorkspaceStore::default())`, returning
  an empty workspace list.
- `session_history/storage.rs:56-82` — same pattern, resets to empty history.
- `last_session.rs:77-84` — corrupt last-session is silently treated as `None` (nothing restored).
- `connection/storage.rs` does better: it attempts *granular* per-node recovery
  (`recover_nodes_recursive`) and only fully resets when the top-level JSON is unparseable
  (`storage.rs:82-100`).

The problem is that **an unparseable file is indistinguishable from a schema mismatch.** Because
there is no version gate or migration (PER-001), a file written by a *newer* app version — after any
non-additive schema change — fails to parse in an *older* app and is treated as corrupt.

## Why it matters

On an auto-updating app this makes **rollback destructive**. Sequence: user is auto-updated to vN+1,
which writes a vN+1-shaped `workspaces.json`; a staged-update revert or a manual downgrade puts vN
back; vN cannot parse the file → backs it up to `.bak` → **overwrites the live file with an empty
default**. The user opens the app to find every saved workspace gone. The `.bak` exists but the user
is never guided to it, and the *next* save (any layout change) can overwrite reasoning about
recovering it. The same applies to session history and — via the empty-`None` path — to the restored
last session.

Even without downgrade, resetting to defaults on genuine corruption is a heavy hammer for stores
where partial recovery is feasible (workspaces are a list; one bad entry need not discard the rest,
the way connections already salvage per-node).

## Evidence

- `workspace/storage.rs:60-73` — on parse failure: `fs::copy` to `.bak`, then
  `self.save(&WorkspaceStore::default())` — the live file is replaced with an empty store.
- `session_history/storage.rs:56-77` — identical reset-to-default.
- `connection/storage.rs:103-163` shows the better model (granular per-node salvage) that the other
  stores lack.

## Recommendation

- Gate on `version` before deciding "corrupt": if the on-disk `version` is **newer** than the app
  supports, do **not** reset — refuse to overwrite, keep the file intact, and surface a clear
  "written by a newer version" warning (this is the downgrade half of PER-001).
- For genuine corruption, prefer **granular recovery** (as `connections.json` already does) so one
  bad entry does not discard the whole store.
- Never let the reset path overwrite the live file until the user has been shown the recovery
  warning and the `.bak` location; consider keeping the original file and writing defaults to a new
  name until acknowledged.
</content>
