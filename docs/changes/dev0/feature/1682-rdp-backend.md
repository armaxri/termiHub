### Added

- RDP (Remote Desktop Protocol) connections. A new **RDP** connection type plugs
  into the shared graphical remote-desktop layer (#1680): it drives the IronRDP
  protocol state machine and decodes the RDP graphics pipeline in Rust into the
  shared canvas, translates keyboard (PC/AT scancodes), mouse and scroll input to
  RDP input PDUs, and injects Ctrl+Alt+Del from the shared toolbar. The connection
  editor exposes RDP-specific options on top of the shared fields — a **domain**
  field, a **security mode** select (Auto / NLA (CredSSP) / TLS / legacy RDP, with
  legacy shown as insecure), an **ignore-certificate-errors** toggle, and a
  console/admin-session toggle. Ships **experimental**: hidden unless experimental
  features are enabled (#1705). (#1682, epic #1678)
