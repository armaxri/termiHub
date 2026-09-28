### Fixed

- The "Connection failed" screen now picks its guidance (SSH agent not running,
  connect timeout, serial port not found / permission denied / in use) from a
  typed failure kind supplied by the backend instead of matching English or
  OS-localized error text. On a non-English system these hints previously
  stopped appearing; they now show regardless of the OS display language. The
  error text is shown in full, and the hint copy is served from a message
  catalog so it can be translated (I18N-009).
- A connect that hits the client-side connect timeout now shows the
  backend-appropriate timeout hint.
