### Changed

- Release builds no longer include the demo/test "Mock Remote Desktop"
  connection type. The mock graphical remote-desktop backend was in the desktop
  crate's default feature set, so it compiled into shipping builds and appeared
  as a user-selectable connection type (previously only hidden behind the
  experimental-features toggle). It is now an opt-in build feature used solely by
  the E2E/integration test lane, so a shipping release never registers it
  (DEAD-001).
