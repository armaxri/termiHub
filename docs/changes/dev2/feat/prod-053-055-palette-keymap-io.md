### Added

- Saved workspaces now appear in the command palette (`Cmd/Ctrl+P`) as
  "Launch Workspace: <name>" entries; selecting one launches that workspace,
  reusing the existing launch path (PROD-053).
- Keyboard Settings can now export and import your custom keyboard shortcuts as a
  JSON file. "Export Shortcuts" writes your current overrides to a JSON file you
  pick; "Import Shortcuts" reads such a file and applies it. The round-trip is
  lossless, and an invalid file is rejected with an error toast without changing
  your existing bindings (PROD-055).
