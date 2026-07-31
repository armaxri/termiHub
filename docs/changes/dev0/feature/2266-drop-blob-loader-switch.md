### Security

- Hardened the Content-Security-Policy: `blob:` is no longer an allowed
  `script-src`. Frontend plugin code now loads inside its Web Worker sandbox from
  the app-controlled `plugin://` origin (served already wrapped by the plugin
  protocol) instead of a `blob:` URL, so the policy no longer needs to permit
  scripts from `blob:` at all. Frontend plugins continue to work exactly as
  before; this only removes an execution avenue an injected script could have
  abused (#2266, completes #2251/#2136).
