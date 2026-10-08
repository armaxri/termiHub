---
id: FEC2-001
title: "Imported run-script steps read a hidden, unrestricted local file (sourcePath) and type its contents into the remote shell, ignoring the script shown in the editor"
angle: frontend-components
severity: medium
category: security
is_workaround: false
subsystem: "src/services/workflowRunner + workflowIo"
evidence:
  - src/services/workflowRunner.ts:518-529
  - src/services/workflowRunner.ts:669-670
  - src/services/workflowIo.ts:212-216
  - src/components/WorkflowSidebar/WorkflowStepRow.tsx:192-194
  - src/store/slices/workflowRunOnTarget.ts:505
  - src/services/api.ts:1965-1967
  - src-tauri/src/commands/files.rs:110-112
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

A `run-script` step can carry an optional `sourcePath`. At run time `resolveScriptBody` reads that path with `localReadFile` (the unrestricted `local_read_file` command, which can read any file the user can read) and sends every line to the session through `deps.send`. The embedded `script` is used only when the path is missing or the read fails, and that fallback is silent. No component or editor shows `sourcePath`: it can only enter through workflow import (`workflowIo.ts:212-216` copies it straight from the JSON), and the step editor keeps it on every edit (`onChange({ ...step, script })`).

## Why it matters

An imported workflow file can show a harmless script in the editor while actually reading something like `~/.ssh/id_ed25519` or `~/.aws/credentials`. When run, that file is typed line by line into a remote shell, where it lands in shell history and logs and is visible to the remote host. The import security summary counts only `run-local-process` steps, so nothing warns about this. Separately, there is a plain correctness bug: once a step has a `sourcePath`, whatever the user types in the Script box is ignored whenever the file can be read. When the file cannot be read, a stale embedded copy runs with no warning. Either way the commands sent to the remote shell are not the ones the user sees.

## Evidence

- `src/services/workflowRunner.ts:518-529`
- `src/services/workflowRunner.ts:669-670`
- `src/services/workflowIo.ts:212-216`
- `src/components/WorkflowSidebar/WorkflowStepRow.tsx:192-194`
- `src/store/slices/workflowRunOnTarget.ts:505`
- `src/services/api.ts:1965-1967`
- `src-tauri/src/commands/files.rs:110-112`

## Recommendation

Drop `sourcePath` on import, or show it in the step editor and include it in the import security summary with an explicit confirmation. Clear `sourcePath` when the user edits the script body. At run time, fail the step with a clear error instead of falling back to the embedded script when the read fails. Consider restricting the read to the workflow's own directory or to paths the user picked through a file dialog.

## Verification

I confirmed every part of the finding in the code at develop 663465d52.

- `resolveScriptBody` (workflowRunner.ts:518-529) reads `step.sourcePath` with `deps.readScriptFile` and falls back to the embedded `script` without any warning if the read fails.
- workflowRunOnTarget.ts:505 sets `readScriptFile: localReadFile`. That calls the `local_read_file` command, which is `std::fs::read_to_string(path)` with no path restriction (src-tauri/src/files/local.rs:121).
- The run-script case (workflowRunner.ts:669-677) sends each line of that body to the session.
- workflowIo.ts:212-216 copies `sourcePath` straight from the imported JSON.
- No frontend component reads or sets `sourcePath`. A search finds it only in the runner, in workflowIo, and in the generated type. So the step editor never shows it, and `onChange({ ...step, script })` keeps it.
- The import result (`WorkflowImportResult`) and its security counting only cover `run-local-process`.

I found no ADR, guard or doc that addresses this. The import code treats imported workflow files as untrusted, which is why it gates `run-local-process` steps. Reading an arbitrary local file and typing it into a remote session gets around that trust boundary.

I rate it medium rather than high:

- The user has to import the file and run the workflow by hand.
- The data only leaves the machine if the attacker can see the remote session, for example by controlling the remote host or reading its logs or history.
- An imported workflow can already run arbitrary visible commands on the remote through send-command, so the new part is limited to exfiltrating local files.

The correctness bug is also real: once a step has a `sourcePath`, script edits are ignored whenever the file can be read, and a stale embedded copy runs silently when it cannot.
