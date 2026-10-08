### Fixed

- Sandboxed plugins on a busy macOS machine no longer let one session's output
  crowd out the others: the plugin channel now serves concurrent sessions
  strictly in arrival order. 40 echo sessions measured a 21-91x throughput
  spread on a 3-core macOS CI runner before and stay within the 2x fairness
  budget now (#4260).
