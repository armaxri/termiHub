### Fixed

- Remote system monitoring (status bar): the CPU stat now shows a muted
  "CPU —" priming indicator until the second sample arrives, instead of a
  solid "CPU 0%". The remote collectors report 0% on the very first sample
  because there is no prior delta to compute a rate from, and the old display
  made that placeholder look like a real reading. Memory and disk are correct
  on the first sample and keep rendering numerically (#1148).
