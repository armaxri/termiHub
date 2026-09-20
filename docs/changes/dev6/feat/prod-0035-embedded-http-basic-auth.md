### Added

- Embedded HTTP servers can now optionally require **HTTP Basic authentication**
  (PROD-0035). Enable it in the server editor's new Authentication section and
  set a username/password; the server then challenges every request with
  `401 Unauthorized` and a `WWW-Authenticate: Basic` prompt until matching
  credentials are supplied. Credentials are verified in constant time (over
  fixed-length digests, so neither their value nor their length leaks via
  timing). Leaving authentication off serves the directory unauthenticated
  exactly as before. Applies to both desktop-hosted and agent-hosted HTTP
  servers, which share the same handler (PROD-0035).
