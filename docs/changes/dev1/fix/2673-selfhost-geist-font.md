### Fixed

- The Geist UI font is now self-hosted from the bundled (OFL-licensed) `geist`
  package instead of being fetched from Google Fonts. The previous remote
  `@import` was blocked by the app's own Content-Security-Policy on every
  launch (`style-src 'self'`), so the intended Geist typography silently fell
  back to a system font for all users and emitted a CSP violation each start.
  The font now loads from a bundled `woff2` asset under the existing CSP with
  no external network request (#2673).
