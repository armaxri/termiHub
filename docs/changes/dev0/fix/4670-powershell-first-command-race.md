### Fixed

- SSH sessions to a slow-starting PowerShell host (for example a cold Windows PowerShell
  start) now still apply the configured environment variables and shell integration before
  the first command runs, instead of silently skipping them when the shell took more than
  8 seconds to identify itself (#4670).
