### Added

- **Per-workspace settings.** A workspace can now override the theme and the terminal
  font family / size, and set a default working directory and extra environment
  variables for new local shells. Edit them in the workspace editor's new **Workspace
  settings** section; leave a field empty to keep the global setting. Launching a
  workspace applies its overrides immediately in every window, and a connection's own
  values still win. Settings marks each overridden setting with **Overridden in
  workspace X** and a **Reset to global** button. Environment variables only affect
  newly opened local shells and are stored in plain text, so the editor warns about
  names that look like secrets. Overrides are included in workspace export/import and
  duplicate.

### Changed

- The workspace store (`workspaces.json`) moved to schema version 2. Existing files are
  upgraded automatically; an older termiHub version will no longer overwrite the
  upgraded file.
- Editing a workspace in the workspace editor no longer drops its multi-window layout.
