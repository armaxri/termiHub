### Added

- Documented the Workflow Automation feature in the README: authored multi-step
  workflows (`send-command`, `run-script`, `run-macro`, `wait`, and the guarded
  local `run-local-process` step), manual / hotkey / on-connect triggers, the
  Workflows sidebar and editor, and workflow import/export. Includes a prominent
  callout that `run-local-process` runs a program on the local machine, is off by
  default, and requires an explicit opt-in under Settings → Security plus a
  per-program allowlist/confirmation (part of epic #1851).

### Changed

- The Workflows panel is now gated behind the experimental-features toggle again,
  matching the other new panels (SSH Tunnels, Services, Network Tools). Enable
  Settings → General → Allow Experimental Features to use it (part of epic #1851).
