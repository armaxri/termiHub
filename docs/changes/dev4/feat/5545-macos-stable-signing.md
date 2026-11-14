### Changed

- macOS: release builds are signed with termiHub's own, stable code-signing certificate
  instead of a fresh ad-hoc signature, so passwords saved in the macOS keychain stay
  readable after an update instead of prompting again (or failing) after every release.
  Gatekeeper's one-time "unverified developer" approval on first install is unchanged
  (no Apple Developer ID). "Always Allow" and the master-password store remain the
  fallback (#5545).
