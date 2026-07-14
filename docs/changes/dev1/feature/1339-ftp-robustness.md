## Added

- FTP connections now send periodic `NOOP` keep-alives (default every 60 seconds, configurable via the new "Keep-alive (s)" setting; set to `0` to disable) so idle sessions are not dropped by server idle-timeouts or NAT eviction.
- FTP file operations (listing, download, upload, rename, delete, mkdir) now auto-reconnect after a dropped control connection — up to 3 retries with exponential backoff — and retry the operation transparently, so a transient network blip no longer surfaces as a hard failure.

## Changed

- FTP passive-mode transfers now prefer extended passive (`EPSV`) and fall back automatically to classic passive (`PASV`) on servers that reject it, improving compatibility (including IPv6) without configuration.
- A failed FTP connect now reports an actionable timeout error that names the host and port and suggests what to check (host/port correctness, server status, firewall), instead of a bare "timed out".
