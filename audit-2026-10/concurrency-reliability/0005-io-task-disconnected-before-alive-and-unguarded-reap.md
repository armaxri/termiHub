---
id: CONC2-005
title: "I/O task emits 'disconnected' before clearing alive, and reap_agent removes the map entry by id with no identity check"
angle: concurrency-reliability
severity: low
category: bug
is_workaround: false
subsystem: src-tauri/terminal/agent_manager
audit: 2026-10
commit: 663465d52
relation: new
status: fixed
resolution: "#4304 — give-up clears alive before the Failed fold and disconnected emit; reap_agent removes the entry and its io_budget only when Arc::ptr_eq matches the task's own alive"
evidence:
  - src-tauri/src/terminal/agent_manager/io_task.rs:740
  - src-tauri/src/terminal/agent_manager/io_task.rs:741
  - src-tauri/src/terminal/agent_manager/io_task.rs:742
  - src-tauri/src/terminal/agent_manager/io_task.rs:745
  - src-tauri/src/terminal/agent_manager.rs:888
  - src-tauri/src/terminal/agent_manager.rs:893
  - src-tauri/src/terminal/agent_manager.rs:1013
  - src-tauri/src/terminal/agent_manager.rs:1567
---

## What

When the reconnect budget runs out, the I/O task folds the hosted tabs to Failed and emits `disconnected` (:740-741) before it stores `alive = false` (:742), then calls `reap_agent` (:745). `reap_agent` does `guard.remove(agent_id)` by id alone; it does not check that the entry is the one this task owns, for example by comparing its `alive` Arc with `Arc::ptr_eq`.

## Why it matters

Two narrow races follow. (a) A redrive or user connect that reacts to the `disconnected` event and runs `connect_agent` before :742 sees `alive == true`. It returns `already_connected`, which `reconnect_retained_agent` treats as success (:1567), so the redrive goes on against a transport that is about to be reaped. (b) A connect that evicts the dead entry and inserts a fresh one before `reap_agent` gets the lock (more likely because `connect_agent` holds that lock for the whole connect) has its new live entry removed. The new I/O task and SSH session are then orphaned outside the map: unreachable, with no abort handle retained.

## Recommendation

Set `alive = false` before the fold and the `disconnected` emit. Make `reap_agent` take the task's own `alive` Arc and remove the entry only when `Arc::ptr_eq(&entry.alive, &own_alive)`. Clear the matching `io_budgets` entry under the same condition.

## Verification

The code is as described. io_task.rs:740-745 folds the tabs, emits 'disconnected', stores alive=false, then calls reap_agent. reap_agent (agent_manager.rs:888-893) does guard.remove(agent_id) with no identity check. The races are real but very narrow. Race (a) needs a connect_agent to land in the microseconds between the emit and alive.store, and an IPC round-trip triggered by the event will almost never be that fast. Race (b) needs a connect to take the lock between alive.store(false) and reap_agent's lock acquisition, also a sub-microsecond window. If it does happen, though, a new live entry is removed from the map and its I/O task is orphaned. The fix (store alive=false first, compare the alive Arc by pointer in reap) is cheap, so this is a valid low-severity hardening finding.
