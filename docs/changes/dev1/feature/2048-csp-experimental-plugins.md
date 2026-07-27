### Added

- Frontend (JavaScript) plugins are now gated behind an explicit, off-by-default
  experimental opt-in (Settings → Plugins → "Enable Frontend (JavaScript)
  Plugins"). For v0.1.0 the full plugin-JS surface — protocol parsers and
  status-bar widgets that run in the main WebView with full app access and weak
  isolation — no longer runs unless the user knowingly enables it, with a
  prominent trust warning. Theme-only and backend plugins are unaffected.
  Toggling the setting loads or tears down injected plugin scripts live (#2048).

### Changed

- Hardened the application security posture with a restrictive Content Security
  Policy (previously `null` / allow-all). Inline scripts are no longer permitted;
  frontend plugin code now loads from a blob URL instead of an inline `<script>`
  so it runs under the strict policy without weakening it (#2048).
