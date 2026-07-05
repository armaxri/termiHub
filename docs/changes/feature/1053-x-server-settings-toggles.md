### Added

- Settings → General now has an **X Server** section with two toggles for SSH
  X11 forwarding: **Provide X Server Automatically** (start a local X server —
  VcXsrv on Windows — automatically; defaults on for Windows) and **Stop X
  Server When Idle** (shut the managed server down once no connection uses it;
  defaults on). Both are searchable in settings. Part of the X server
  provisioning epic (#1047, #1053).
