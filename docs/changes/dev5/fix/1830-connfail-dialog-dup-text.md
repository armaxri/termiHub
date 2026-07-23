### Fixed

- Connection-failed dialog no longer shows the remediation guidance and fix
  command twice. Serial errors whose backend message embeds a remediation hint
  (e.g. the `sudo usermod -aG dialout $USER` advice for a permission-denied
  serial port) previously rendered that text both in the raw error box and in
  the formatted hint panel below it. The raw error box now shows only the
  concise failure reason, leaving the hint panel — with its copyable command
  (#1829) — as the single source of the remediation (#1830).
