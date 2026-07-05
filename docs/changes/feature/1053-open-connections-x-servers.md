### Added

- Open Connections panel now has an **X Servers** section showing termiHub's
  shared local X server (used for SSH X11 forwarding). A termiHub-managed server
  appears as `VcXsrv · display :N` with a **Stop** control; an adopted external
  server appears as `External X server · display :N` with no stop (termiHub did
  not start it, so it does not stop it). The section is hidden when no server is
  running. Part of the X server provisioning epic (#1047, #1053).
