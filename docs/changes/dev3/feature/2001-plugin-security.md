### Added

- Plugin security hardening (concept §13, "Security and polish"): the plugin
  host now enforces a plugin's declared permissions and recovers from
  misbehaving plugins.
  - **Permission enforcement**: a plugin whose extensions need a capability it
    did not request is refused at load with a clear error rather than loaded —
    a terminal backend without the `terminal` permission, or the `filesystem`
    permission without declared paths, is rejected (graceful degradation, not a
    crash).
  - **Path-scoped filesystem access**: plugins declare a `filesystemPaths` list
    in their manifest and the host confines filesystem access to those roots,
    rejecting paths outside them and any `..` traversal that escapes a root.
  - **Untrusted-source install gate**: every package is treated as unsigned, so
    the install dialog shows an "untrusted source" warning the user must accept
    before extraction. (Cryptographic signature verification remains future
    work — termiHub has no signing substrate, so no plugin is claimed to be
    "signed" or "verified".)
  - **Error recovery**: a crashing plugin is auto-restarted up to 3 times and
    then auto-disabled; plugin FFI entry points are called under panic guards so
    a panicking plugin can never abort the host. Plugins made incompatible by an
    app plugin-API bump are auto-disabled on startup with a notification.
