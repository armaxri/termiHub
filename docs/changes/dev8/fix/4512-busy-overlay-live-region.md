### Fixed

- Screen readers now reliably announce the in-progress connection screens
  (Connecting…, Restoring session…, Waiting for agent…, Reconnecting…, and the
  remote-desktop Connecting / Authenticating / Reconnecting states). Their text
  previously lived in a live region that appeared together with its text, which
  many screen readers ignore; it is now spoken through a live region that is in
  place before the text arrives, exactly once per state change (#4512).
