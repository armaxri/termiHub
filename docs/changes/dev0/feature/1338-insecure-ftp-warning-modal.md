# Changes for feature/1338-insecure-ftp-warning-modal

## Added

- Plaintext FTP connections now show an insecure-connection warning before the
  control connection opens, with **Connect Anyway** / **Cancel** and a
  per-connection **"Don't warn again for this connection"** option. FTPS
  (explicit or implicit) never shows the warning.
- The FTP connection editor now shows an inline warning callout while TLS Mode
  is **None**, and hides it for FTPS.

## Changed

- The FTP editor auto-adjusts the control port when you change TLS Mode — 990
  for implicit FTPS, 21 otherwise — while preserving a custom port you set.
