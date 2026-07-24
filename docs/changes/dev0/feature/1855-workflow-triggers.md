### Added

- Workflow trigger dispatch (#1855, epic #1851): saved workflows can now be
  launched three ways at runtime.
  - **Manual** — a "Run Workflow: &lt;name&gt;" entry appears in the command
    palette for every saved workflow (alongside the existing sidebar run
    action), running it against the active terminal.
  - **Hotkey** — a workflow with a `hotkey` trigger runs when its assigned key
    combo is pressed while no app shortcut claims it, reusing the shared
    keybinding matcher (explicitly unbound bindings never fire).
  - **On-connect** — a workflow bound to one or more connections runs
    automatically, once per session open, when an interactive terminal session
    for a bound connection finishes opening.

  All three route through the store's existing single-run-at-a-time
  `runWorkflow`.
