### Fixed

- Enabling, disabling and uninstalling a plugin from the Plugins UI failed
  with a missing-argument error: the frontend sent the plugin id under the
  wrong argument name. Fixed (#3488).

### Internal

- New `scripts/internal/check-invoke-contract.mjs` gate (CI + `check.sh`)
  statically cross-checks every frontend `invoke()` call against the
  registered Rust `#[tauri::command]` parameters, failing on unknown commands,
  missing required arguments and unknown extra arguments.
