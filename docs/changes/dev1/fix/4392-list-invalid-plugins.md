### Fixed

- Plugins: an installed plugin whose manifest no longer passes validation (for
  example one installed before a stricter manifest rule landed) no longer
  disappears from the plugin list. It is shown in the Error state with the
  reason, is never loaded, and can be uninstalled from the UI (#4392).
