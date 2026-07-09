### Fixed

- When opening the SFTP file browser, termiHub now lands in your actual remote
  home directory. It resolves the real home from the server (via SFTP realpath)
  instead of guessing `/home/<username>`, which was wrong for macOS, BSD, and
  custom home layouts and silently dropped you at `/`. If the server can't
  resolve the home, the browser still opens at root as before (audit gap C2,
  #1143).
