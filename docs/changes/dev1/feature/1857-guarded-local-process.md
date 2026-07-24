### Added

- Workflow automation: the guarded **`run-local-process`** step can now execute a
  local program on your machine as part of a workflow (#1857, epic #1851) —
  behind hard security guardrails:
  - **Off by default.** A new Security setting, "Allow workflows to run local
    programs" (`workflowLocalProcessEnabled`), gates all local-process execution;
    while off, any `run-local-process` step is refused. The backend spawn command
    re-checks the same opt-in, so a step can never run without it.
  - **Per-program confirmation and allowlist.** The first time a workflow runs a
    not-yet-trusted program, a dialog shows the exact program and its discrete
    arguments and asks to allow it once, always (remembered on an allowlist,
    manageable under Settings → Security), or cancel. Imported workflows are
    never pre-authorized.
  - **No shell, no injection.** Programs are spawned with a direct argument
    vector — never through a shell and never by concatenating arguments into a
    command line. The step editor now takes arguments as a discrete list, so an
    argument containing spaces stays a single, literal argument.
  - **Bounded and observable.** Execution has an enforced timeout, can be
    cancelled with the running workflow, streams stdout/stderr into the log
    viewer, and surfaces the process exit status.
