### Added

- **Plugin update check (opt-in, never automatic).** A plugin can publish an
  HTTPS update URL in its manifest. The Plugins view then offers **Check for
  updates**, marks plugins that have a newer version, and the plugin's detail
  panel shows the new version with a changelog link and **Download &
  install…**. The download is size-capped and verified against the published
  SHA-256, plugin id and version, then opened in the regular install dialog,
  so the signature/trust banner, permissions and confirmations still apply.
  Only strictly newer versions are offered; one that needs a newer termiHub is
  flagged instead. **Settings → Plugins → Check for Plugin Updates
  Automatically** adds a daily background check and is off by default. There
  is still no plugin store: plugins are installed from local files (#3484,
  #3382).
- **Example JavaScript plugins**: `log-highlighter` (a protocol parser that
  colors `ERROR`/`WARN` in terminal output) and `clock-widget` (a status-bar
  widget) under `examples/plugins/`, documented in the plugin authoring guide
  (#3484).

### Changed

- Installing a different version of a plugin now drops stored plugin settings
  that no longer match the new version's declared settings, so their new
  defaults apply; settings that still match carry over (#3484).
