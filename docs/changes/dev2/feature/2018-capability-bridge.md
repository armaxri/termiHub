### Added

- Plugin host-mediated capability bridge: a native plugin's `network` and
  `filesystem` permissions are now enforced **at runtime**, not just validated at
  load. The plugin ABI (`termihub-plugin-api`, bumped to version 2) gained a
  `PluginHostBridge` that the host passes into `create_backend`; a plugin opens
  connections and reads files *through* the bridge, and the host checks the
  session's granted `PermissionSet` / declared filesystem scope before performing
  each operation. A plugin without `network` cannot open a connection, and a read
  outside the declared paths is refused. The bridge mediates cooperative access;
  it is not an OS sandbox (a follow-up tracks full mediated write/streaming
  surfaces). Realises concept §13, building on the permission primitives from
  #2001 (#2018).
