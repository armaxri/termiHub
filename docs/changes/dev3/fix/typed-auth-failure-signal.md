### Fixed

- A saved connection with a stored password/passphrase no longer risks losing a
  valid credential — or getting stuck retrying a stale one — on a connect
  failure. The decision to discard a stored credential on an authentication
  failure was previously made by matching the backend/remote error message
  against the English text `"auth failed"`. A localized, reworded, or
  remote-origin message could either delete a still-valid credential (any
  non-auth error whose text happened to contain that phrase) or leave a
  genuinely stale credential in place (a non-English rejection), trapping the
  user in a retry loop. SSH/agent authentication failures now carry a typed,
  locale-independent signal across the app, and the credential discard is gated
  on that signal rather than on the human-readable message text.
