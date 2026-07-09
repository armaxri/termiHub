### Added

- **Set up X server** flow for SSH X11 forwarding. The Open Connections panel's
  **X Servers** section now offers a **Set up** action when no local X server is
  running. It opens a consent dialog (nothing is downloaded or launched before
  you confirm), then streams live provisioning progress; on success the new
  server appears in the panel. If a platform dependency is missing (e.g. XQuartz
  on macOS), the dialog surfaces the guidance and an **Install** action. Part of
  the X server provisioning epic (#1047, #1053).
