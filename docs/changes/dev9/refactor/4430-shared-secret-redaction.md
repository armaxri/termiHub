### Security

- Logs: copied or saved log text, the "Copy debug info" bundle and exported diagnostics now
  mask secrets under any camelCase, snake_case or kebab-case key ending in a secret word
  (for example `keyPassphrase`, `clientSecret`, `api_token`, `simPin`), and the log viewer
  now also masks `cookie`, `otp`, `totp` and `pin` values. Both redactors share one list
  of secret key names, so they can no longer drift apart (#4430).
