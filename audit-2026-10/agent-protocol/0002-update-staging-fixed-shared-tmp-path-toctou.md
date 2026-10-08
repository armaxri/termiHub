---
id: AGT2-002
title: "Coordinated agent update stages the binary at a fixed, world-shared /tmp path and verifies it by path, then copies it by path again (TOCTOU, multi-user collision)"
angle: agent-protocol
severity: medium
category: security
is_workaround: false
subsystem: "agent/src/update (apply path) + src-tauri agent_install/agent_deploy"
evidence:
  - agent/src/update/apply.rs:371
  - agent/src/update/apply.rs:378-383
  - agent/src/update/apply.rs:126-128
  - agent/src/update/apply.rs:512-515
  - agent/src/update/apply.rs:560-568
  - agent/src/update/apply.rs:692-694
  - src-tauri/src/terminal/agent_install.rs:21
  - src-tauri/src/terminal/agent_install.rs:85-89
  - src-tauri/src/terminal/agent_setup.rs:33
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

For a coordinated update, the desktop uploads the agent over SFTP to the fixed path `/tmp/termihub-agent-upload`, and the agent trusts that path as a staging root (`production_staging_roots`). Four problems follow. (1) The root itself is canonicalized, so a symlink at `/tmp/termihub-agent-upload` resolves the same way on both sides and passes `confine_to_staging`. (2) Nothing checks that the staged file is owned by the agent's uid or has safe permissions. (3) Apply hashes the file by path (`verify_file_checksum` → `sha256_hex_of_file`), checks the version from that path, then calls `replace_binary`, which opens the same path again and copies it (apply.rs:692-694). The bytes that get installed are therefore not necessarily the bytes that were verified. (4) Nothing removes the file after a successful apply.

## Why it matters

On a multi-user agent host (a shared jump box, a lab server), another local user can pre-create `/tmp/termihub-agent-upload` as a world-writable file they own. On macOS, or Linux without `fs.protected_regular`, the victim's SFTP open with O_TRUNC writes into that attacker-owned file. The attacker then swaps the contents between the apply-time hash and the copy (inotify on close makes the window easy to hit). The result is an attacker-chosen binary installed and exec'd as the victim, which is local privilege escalation and defeats the AGT-003/004/005 guarantees. The same fixed name also causes a functional bug even without an attacker: once one user's upload is left in /tmp (it is never deleted), every other user's agent install or update on that host fails with permission denied.

## Evidence

- `agent/src/update/apply.rs:371`
- `agent/src/update/apply.rs:378-383`
- `agent/src/update/apply.rs:126-128`
- `agent/src/update/apply.rs:512-515`
- `agent/src/update/apply.rs:560-568`
- `agent/src/update/apply.rs:692-694`
- `src-tauri/src/terminal/agent_install.rs:21`
- `src-tauri/src/terminal/agent_install.rs:85-89`
- `src-tauri/src/terminal/agent_setup.rs:33`

## Recommendation

Stop using a shared fixed /tmp name. Upload to a per-user private location, either `<config_dir>/updates` (already a staging root, created 0700) or a `mktemp -d` directory created by the remote command, and pass that path in. At apply time, open the staged file once with O_NOFOLLOW, check fstat shows uid == geteuid() and no group/other write bits, copy it into the private temp file next to the executable, and only then hash, signature-check and version-check that private copy before renaming it into place. Delete the staged upload after a successful apply. Do the same for agent_setup.rs `TEMP_UPLOAD_PATH` and the initial-install mv command.

## Verification

Confirmed against the code. The constant is defined at apply.rs:371, agent_install.rs:21 and agent_setup.rs:33; `production_staging_roots` trusts it; `confine_to_staging` (apply.rs:105-136) only canonicalizes and checks containment. The file is hashed by path, version-checked by path, then `replace_binary` (~apply.rs:688) reopens it with `File::open(src)` and copies, so installed bytes are not tied to verified bytes. No uid/O_NOFOLLOW check exists in agent/src/update and the staged upload is never removed after success. The desktop uses `sftp.create` (remote_exec.rs:380, O_CREAT|O_TRUNC) and only removes the file on upload failure (agent_deploy.rs:782-794). No ADR accepts this; apply-path comments wrongly claim the re-hash closes the TOCTOU. Lowered from high to medium: it needs a second local user, a kernel without `fs.protected_regular=1` (macOS or older/hardened-off Linux), and a won race; the result is user-to-user code execution, not root. The shared-name install/update failure on multi-user hosts holds even with no attacker.
