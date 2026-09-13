### Fixed

- Plugin-declared, user-configurable manifest `settings` (e.g. a plugin's
  `defaultNamespace`) now actually take effect. They were persisted and editable
  but never handed to a native backend plugin, so a declared setting silently did
  nothing. The effective settings — the manifest defaults overlaid with the
  user's stored overrides — are now delivered to the backend at session creation
  alongside the per-connection config. Plugins that declare no settings are
  unaffected (an empty object is delivered) (PLG-008).
