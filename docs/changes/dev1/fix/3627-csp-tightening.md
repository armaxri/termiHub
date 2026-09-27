### Security

- Tightened the app's Content-Security-Policy. On macOS and Linux, scripts may
  no longer load from `http://plugin.localhost`, which is only the Windows form
  of the plugin origin. Fonts may no longer load from `data:` URLs. The
  remaining relaxations are documented and guarded by a test (#3627).
- The form validator no longer attempts a blocked `eval` probe, which had
  logged a CSP violation (#3627).
