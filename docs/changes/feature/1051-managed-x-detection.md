### Fixed

- SSH X11 forwarding (Windows): a user-run X server (e.g. VcXsrv) listening on
  `127.0.0.1:6000` is now discovered even when `DISPLAY` is unset. Local X-server
  detection previously only scanned `/tmp/.X11-unix` and shelled out to `xauth` —
  both no-ops on Windows — so a running X server was never found. Detection now
  falls back to a TCP probe of display `:0` on Windows (#1051).

### Changed

- SSH X11 forwarding: local X-server detection is now managed-server-aware. When
  termiHub itself provisions an X server (upcoming, epic #1047), detection returns
  it directly as a loopback TCP connection with its known MIT-MAGIC-COOKIE-1,
  bypassing all filesystem and `xauth` probing. Unix behavior is unchanged (#1051).
