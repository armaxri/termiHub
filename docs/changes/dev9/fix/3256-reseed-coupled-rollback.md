### Fixed

- A rejected whole-layout resync (e.g. when opening the Settings tab) now also reverts
  the related tab state it changed — the Settings deep-link target and the tab's
  content entry — instead of leaving them out of step with the restored layout. A newer
  change made in the meantime is kept (#3256).
