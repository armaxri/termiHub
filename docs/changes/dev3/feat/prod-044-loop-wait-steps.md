# Changes

## Added

- Workflow automation now supports two control-flow step types beyond linear and
  conditional steps (PROD-044):
  - **Loop** — repeat a body of steps a fixed number of times, or while a
    structured condition holds. A reserved `${iteration}` variable (0-based) is
    available to the body and the while-condition. A max-iteration safety cap
    guarantees a while-loop can never run forever.
  - **Wait for output** — pause the workflow until the target terminal's output
    matches a pattern (a literal substring by default, or a regular expression)
    or a timeout elapses. A default timeout applies so the step can never hang.
  - Both are editable in the Workflow editor, round-trip through workflow
    import/export, and leave existing workflows unchanged.
