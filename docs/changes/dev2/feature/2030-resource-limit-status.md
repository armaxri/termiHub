### Changed

- Plugin capability bridge: connection-limit refusals now carry a **dedicated
  status**. When a plugin's mediated `open_connection` is refused because the
  session is already at its concurrent-connection ceiling (#2028), the host now
  reports the new `PluginStatus::ResourceLimit` / `PluginError::ResourceLimit`
  instead of overloading `PermissionDenied`. A plugin author can now tell "I lack
  the `network` permission" (still `PermissionDenied`) apart from "I hit my
  connection ceiling" and back off / retry rather than treat the refusal as a hard
  permission failure. Because the host can now hand a plugin a status value older
  plugins cannot decode, the plugin ABI version is bumped **3 → 4**; plugins built
  against version 3 are rejected at load rather than fed an unknown discriminant
  (#2030).
