### Fixed

- The HTTP Monitor can watch `localhost` and LAN hosts again. It has a new
  **Private network** checkbox, off by default. Since the SSRF hardening
  (SEC-008), every loopback or private target failed with "blocked by SSRF
  protection", and the UI offered no way to allow it (#4017).
