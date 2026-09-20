# Changes

## Added

- **Parameterized workflows (PROD-0040).** A workflow can now declare typed
  parameters (string, number, boolean, or enum) in the workflow editor. Step
  text fields — a send-command's command, a run-script's script, and a
  run-local-process's program and arguments — may reference a parameter as
  `${name}`. When the workflow runs, a prompt collects a value for each
  parameter (pre-filled from its default), and the references are substituted
  before the steps execute. Write `$${` to emit a literal `${` (for shell
  variables); an undeclared `${x}` is left untouched and a warning is logged, so
  a run never fails over an unknown reference. Workflows with no parameters are
  unchanged.
