### Added

- macOS SSH X11 forwarding: termiHub now detects XQuartz and, when it is
  missing, offers an explicit, consent-based install instead of silently doing
  nothing — `brew install --cask xquartz` when Homebrew is present (admin auth
  prompted by Homebrew itself), otherwise actionable guidance to download it
  from xquartz.org. When XQuartz is present, termiHub launches it if idle so a
  forwarded remote window renders locally. No install ever runs silently
  (#1054, epic #1047).
