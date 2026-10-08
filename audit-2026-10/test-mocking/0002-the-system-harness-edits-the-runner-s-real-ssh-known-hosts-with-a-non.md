---
id: MOCK2-002
title: "The system harness edits the runner's real ~/.ssh/known_hosts with a non-atomic read-modify-write and leaves stale entries behind when a run is killed"
angle: test-mocking
severity: medium
category: test-hermeticity
is_workaround: true
subsystem: "tests/system/termihub_harness/local_agent.py (LocalAgentSshd, NativeSshdFixture)"
evidence:
  - tests/system/termihub_harness/local_agent.py:95
  - tests/system/termihub_harness/local_agent.py:88
  - tests/system/termihub_harness/local_agent.py:195
  - tests/system/termihub_harness/local_agent.py:208
  - tests/system/termihub_harness/local_agent.py:212
  - tests/system/termihub_harness/local_agent.py:219
  - tests/system/termihub_harness/local_agent.py:221
  - tests/system/termihub_harness/local_agent.py:311
  - tests/system/termihub_harness/local_agent.py:396
  - tests/system/termihub_harness/local_agent.py:410
  - tests/system/termihub_harness/orchestrator.py:183
  - core/src/backends/ssh/host_key.rs:214
  - tests/system/tests/test_ssh_tunnels.py:125
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

To satisfy the app's strict host-key verifier (#1969), `LocalAgentSshd` and `NativeSshdFixture` append a `[127.0.0.1]:<port>` line to the real `Path.home()/.ssh/known_hosts` (:95/:208, :311/:397). Cleanup reads the whole file, filters it with a substring match, and calls `write_text` (:218-221, :407-410). That truncates and rewrites the developer's real trust file in place, with no temp-file-plus-rename and no lock. Registration only appends and never removes an earlier entry for the same marker. `LocalAgentSshd` takes its port from `free_port()`, a bind-0 / close / reuse pattern. The orchestrator does not override HOME, so the app reads the same file.

## Why it matters

(1) If a run is interrupted mid-rewrite (Ctrl-C during teardown is common locally), the user's real known_hosts can end up truncated, and every trusted host key is lost. (2) Ten checkouts share one $HOME. Two concurrent runs both read-modify-write the file, so one cleanup can erase the other's freshly appended entry. The other run's agent connect then fails as an unknown host, an intermittent failure caused by test infrastructure. (3) A killed run (SIGKILL, CI or job timeout, coordinator reaping) leaves its line behind. A later run that gets the same port with a new throwaway host key now has an older, mismatching entry first, and the verifier reports 'SSH host key CHANGED' (host_key.rs:214), which is a non-deterministic failure. (4) The substring marker `[127.0.0.1]:2222` also matches a user's own `[127.0.0.1]:22220` entry and deletes it.

## Recommendation

Stop touching the real file. Preferred: give the app a test-only known_hosts path, either via an env override such as `TERMIHUB_KNOWN_HOSTS_FILE` honoured only in test-bridge/debug builds, or by launching the app with HOME pointed at a per-run temp dir. Then seed that temp file. If the real file must stay: write with temp file + `os.replace`, hold an `fcntl`/msvcrt lock around the read-modify-write, match the host token exactly (first whitespace-delimited field), and remove any existing line for the marker before appending.

## Verification

Confirmed. LocalAgentSshd and NativeSshdFixture append to Path.home()/.ssh/known_hosts (lines ~95/208, ~311/397) and clean up with read + filter + write_text (:218-221, :407-410). The rewrite is non-atomic, unlocked and matched by substring, so `[127.0.0.1]:2222` also matches `[127.0.0.1]:22220`. Nothing removes a stale entry before appending. The orchestrator only overrides XDG_CONFIG_HOME, not HOME, so the app reads the real file. Concurrent runs across slots that share $HOME can race, and a killed run leaves a stale line behind that can trigger a host-key-changed failure when a port is reused. It is test-only, but it modifies the user's real trust file.
